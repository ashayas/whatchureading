#!/usr/bin/env python3
"""Retrieve Goodreads RSS over HTTP; no Chrome, cookies, or API key required for public shelves."""

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

from goodreads import Document


def parse_feed(source, user_id, shelf=None):
    root = ET.fromstring(source)
    if root.tag != "rss":
        raise ValueError("Goodreads did not return RSS (login/error responses are refused)")
    channel = root.find("channel")
    if channel is None or not re.search(rf"/review/list_rss/{re.escape(user_id)}(?:[?/#]|$)", channel.findtext("link", "")):
        raise ValueError("RSS subject does not match requested Goodreads user")
    if shelf is not None and parse_qs(urlparse(channel.findtext("link", "")).query).get("shelf") != [shelf]:
        raise ValueError("RSS shelf does not match requested shelf")
    records = []
    for item in channel.findall("item"):
        fields = {node.tag: node.text or "" for node in item if node.tag not in {"book", "description"}}
        review_match = re.search(r"https://www\.goodreads\.com/review/show/(\d+)(?:[?/#]|$)", fields.get("guid", ""))
        if not review_match:
            raise ValueError("Missing Goodreads review ID")
        records.append({
            "goodreads_review_id": review_match[1],
            "goodreads_book_id": fields["book_id"],
            "title": fields["title"],
            "author": fields.get("author_name", ""),
            "shelves": [s.strip() for s in fields.get("user_shelves", "").split(",") if s.strip()],
            "rating": float(fields.get("user_rating", "0")) or None,
            "review_text": Document(fields.get("user_review", "")).root.prose().strip(),
            "review_html": fields.get("user_review", ""),
            "book_description_html": fields.get("book_description", ""),
            "book_description_text": Document(fields.get("book_description", "")).root.prose().strip(),
            "pages": item.findtext("book/num_pages"),
            "rss_fields": fields,
        })
    return records


def fetch(user_id, expected_count, cache_dir, cached_only=False, shelf="#ALL#"):
    if not user_id.isdigit() or expected_count < 0:
        raise ValueError("Numeric user ID and nonnegative expected count required")
    cache_dir.mkdir(parents=True, exist_ok=True)
    records = []
    page = 1
    page_limit = max(1, (expected_count + 99) // 100) + 1
    while page <= page_limit:
        suffix = "" if shelf == "#ALL#" else "-" + shelf
        path = cache_dir / f"{user_id}-rss{suffix}-{page}.xml"
        if not path.exists():
            if cached_only:
                raise ValueError(f"Missing cached page {page}")
            url = "https://www.goodreads.com/review/list_rss/" + user_id + "?" + urlencode({"shelf": shelf, "page": page})
            req = Request(url, headers={"Accept": "application/rss+xml, application/xml", "User-Agent": "whatchureading-import/0.1"})
            with urlopen(req, timeout=30) as response:
                source = response.read()
            parse_feed(source, user_id, shelf)
            path.write_bytes(source)
            path.chmod(0o600)
        batch = parse_feed(path.read_bytes(), user_id, shelf)
        if not batch:
            break
        records.extend(batch)
        ids = [r["goodreads_review_id"] for r in records]
        if len(ids) != len(set(ids)):
            raise ValueError("Overlapping RSS pagination; refusing an incomplete import")
        print(f"RSS {shelf} page {page}: {len(batch)} records", flush=True)
        if len(records) >= expected_count:
            break
        page += 1
    if len(records) != expected_count:
        raise ValueError(f"Expected {expected_count} books; retrieved {len(records)}")
    return records


def enrich(staged, records, user_id):
    if staged["goodreads_user_id"] != user_id:
        raise ValueError("Staged subject mismatch")
    by_id = {r["goodreads_review_id"]: r for r in records}
    if set(by_id) != {r["goodreads_review_id"] for r in staged["records"]}:
        raise ValueError("RSS and staged library IDs do not match")
    for record in staged["records"]:
        rss = by_id[record["goodreads_review_id"]]
        if rss["goodreads_book_id"] != record["goodreads_book_id"] or rss["rating"] != record["rating"] or set(rss["shelves"]) != set(record["shelves"]):
            raise ValueError("RSS/table book, rating or shelf mismatch for " + record["goodreads_review_id"])
        record["rss"] = rss
    staged["retrieval"] = {"bulk_transport": "HTTP RSS", "rss_verified_books": len(records), "retrieved_at": datetime.now(timezone.utc).isoformat(), "discussion_transport": "authenticated browser fallback", "full_timeline_coverage": False}
    return staged


def enrich_discussions(staged, discussions):
    by_id = {d["goodreads_review_id"]: d for d in discussions}
    known_ids = {r["goodreads_review_id"] for r in staged["records"]}
    if len(by_id) != len(discussions) or not set(by_id).issubset(known_ids):
        raise ValueError("Unknown or duplicate discussion review IDs")
    for record in staged["records"]:
        discussion = by_id.get(record["goodreads_review_id"])
        if discussion is not None:
            if discussion["goodreads_user_id"] != staged["goodreads_user_id"] or discussion["rating"] != record["rating"]:
                raise ValueError("Discussion subject/rating mismatch")
            comments = discussion["comments"]
            if len(comments) != record["comment_count"] or len({c["id"] for c in comments}) != len(comments):
                raise ValueError("Incomplete or duplicate comments")
            record["discussion"] = discussion
        elif record["comment_count"]:
            raise ValueError("Missing discussion for review with comments")
    staged["retrieval"]["review_threads_with_comments_captured"] = len(by_id)
    staged["retrieval"]["comments_captured"] = sum(len(d["comments"]) for d in discussions)
    staged["retrieval"]["review_pages_with_reading_history"] = sum("reading_history" in d for d in discussions)
    return staged


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--user-id", required=True)
    parser.add_argument("--expected-count", type=int, required=True)
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--cached-only", action="store_true")
    parser.add_argument("--read-count", type=int, help="Verify read membership via the filtered feed; Goodreads omits 'read' from user_shelves")
    parser.add_argument("--enrich", type=Path, help="Optional existing staged library; verifies IDs, ratings and all shelves")
    parser.add_argument("--discussions", type=Path, help="JSON list of authenticated discussion captures; verifies all nonzero comment counts")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    records = fetch(args.user_id, args.expected_count, args.cache_dir, args.cached_only)
    if args.read_count is not None:
        read_records = fetch(args.user_id, args.read_count, args.cache_dir, args.cached_only, shelf="read")
        read_ids = {r["goodreads_review_id"] for r in read_records}
        if not read_ids.issubset({r["goodreads_review_id"] for r in records}):
            raise ValueError("Read feed contains IDs outside the complete library")
        for record in records:
            if record["goodreads_review_id"] in read_ids:
                record["shelves"] = list(dict.fromkeys(["read", *record["shelves"]]))
                record["membership_evidence"] = "filtered read RSS feed"
    result = {"schema_version": 2, "source": "goodreads-rss", "goodreads_user_id": args.user_id, "records": records}
    if args.enrich:
        result = enrich(json.loads(args.enrich.read_text()), records, args.user_id)
    if args.discussions:
        if not args.enrich:
            parser.error("--discussions requires --enrich")
        result = enrich_discussions(result, json.loads(args.discussions.read_text()))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    args.output.chmod(0o600)
    print(f"Saved {len(records)} verified records to {args.output}")


if __name__ == "__main__":
    main()
