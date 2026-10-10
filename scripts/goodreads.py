#!/usr/bin/env python3
"""Stage saved Goodreads shelf HTML without cookies, credentials, or remote writes."""

import argparse
from collections import Counter
from datetime import date
from html.parser import HTMLParser
import json
from pathlib import Path
import re
from urllib.parse import parse_qs, urlparse


class Node:
    def __init__(self, tag="", attrs=()):
        self.tag, self.attrs, self.children = tag, dict(attrs), []

    def find(self, predicate):
        return [n for n in self.walk() if predicate(n)]

    def walk(self):
        yield self
        for child in self.children:
            if isinstance(child, Node):
                yield from child.walk()

    def text(self):
        return "".join(c.text() if isinstance(c, Node) else c for c in self.children)

    def prose(self):
        if self.tag == "br":
            return "\n"
        if self.tag in {"script", "style", "label"}:
            return ""
        value = "".join(c.prose() if isinstance(c, Node) else c for c in self.children)
        return value + ("\n" if self.tag in {"p", "blockquote"} else "")

    def has_class(self, value):
        return value in self.attrs.get("class", "").split()


class Document(HTMLParser):
    VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}

    def __init__(self, source):
        super().__init__(convert_charrefs=True)
        self.root = Node()
        self.stack = [self.root]
        self.feed(source)

    def handle_starttag(self, tag, attrs):
        node = Node(tag, attrs)
        self.stack[-1].children.append(node)
        if tag not in self.VOID:
            self.stack.append(node)

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                break

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def clean(value):
    return re.sub(r"\s+", " ", value).strip()


def parse_date(raw):
    """Retain uncertainty: never invent a day for a month/year-only date."""
    raw = clean(raw).replace("[edit]", "").strip()
    if not raw or raw.lower() == "not set":
        return None
    months = {m: i + 1 for i, m in enumerate("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split())}
    match = re.fullmatch(r"([A-Z][a-z]{2}) (?:(\d{1,2}), )?(\d{4})", raw)
    if match and match[1] in months:
        month, day, year = months[match[1]], match[2], int(match[3])
        if day:
            return {"value": date(year, month, int(day)).isoformat(), "precision": "day", "raw": raw}
        date(year, month, 1)
        return {"value": f"{year:04}-{month:02}", "precision": "month", "raw": raw}
    if re.fullmatch(r"\d{4}", raw):
        date(int(raw), 1, 1)
        return {"value": raw, "precision": "year", "raw": raw}
    return {"value": None, "precision": "unknown", "raw": raw}


def extract(source, user_id, name, memberships=None, partial=False, friend_default_status=None):
    root = Document(source).root
    title_nodes = root.find(lambda n: n.tag == "title")
    title = clean(title_nodes[0].text()) if title_nodes else ""
    expected_match = re.search(r"\(([\d,]+) books?\)", title)
    if not expected_match:
        raise ValueError("Not a Goodreads book table (login/error pages are refused)")
    body = root.find(lambda n: n.attrs.get("id") == "booksBody")
    if len(body) != 1:
        raise ValueError("Missing unique booksBody")
    # Header My Books points to the logged-in viewer; validate the subject using
    # the shelf controls, which belong to the actual library being extracted.
    subject_links = root.find(lambda n: n.tag == "a" and re.search(rf"/review/list/{re.escape(user_id)}(?:[?\-/]|$)", n.attrs.get("href", "")) and re.search(r"All\s*\(", n.text()))
    if not subject_links:
        raise ValueError("Goodreads subject does not match --user-id")
    records = []
    for row in body[0].find(lambda n: n.tag == "tr" and n.attrs.get("id", "").startswith("review_")):
        review_id = row.attrs["id"].removeprefix("review_")
        fields = {}
        cells = row.find(lambda n: n.tag == "td" and n.has_class("field"))
        for cell in cells:
            key = next(c for c in cell.attrs["class"].split() if c != "field")
            values = cell.find(lambda n: n.has_class("value"))
            fields[key] = values[0] if values else cell
        text = lambda key: clean(fields[key].text()) if key in fields else ""
        book_links = fields["title"].find(lambda n: n.tag == "a")
        book_url = book_links[0].attrs["href"]
        book_id = re.search(r"/book/show/(\d+)", book_url)[1]
        if memberships is not None:
            shelves = memberships.get(review_id)
            if not shelves and not partial:
                raise ValueError(f"Missing subject shelf membership for review {review_id}")
        else:
            # On a friend's page this cell is YOUR shelves, not the friend's.
            # Explicit membership input is therefore mandatory for friend imports.
            ratings = fields["rating"].find(lambda n: n.has_class("stars"))
            if friend_default_status:
                read_count = re.search(r"# times read\s+(\d+)", text("read_count"), re.I)
                read_dates = fields["date_read"].find(lambda n: n.has_class("editable_date"))
                has_read_date = any(clean(n.text()).lower() != "not set" for n in read_dates)
                fallback_shelf = {"want": "to-read", "reading": "currently-reading", "did-not-finish": "did-not-finish"}[friend_default_status]
                shelves = ["read"] if (has_read_date or (read_count and int(read_count[1]) > 0)) else [fallback_shelf]
            elif not ratings or ratings[0].attrs.get("data-user-id") != user_id:
                raise ValueError("Friend library requires --memberships; viewer shelves cannot be used")
            else:
                shelves = [clean(n.text()) for n in fields["shelves"].find(lambda n: n.tag == "a" and n.has_class("shelfLink"))]
        images = fields["cover"].find(lambda n: n.tag == "img")
        stars = fields["rating"].find(lambda n: n.has_class("readOnlyStar"))
        own_stars = fields["rating"].find(lambda n: n.has_class("stars"))
        if friend_default_status and (not own_stars or own_stars[0].attrs.get("data-user-id") != user_id):
            rating = sum(1 for n in stars if n.has_class("full") or n.has_class("p10")) + sum(.5 for n in stars if n.has_class("half") or n.has_class("p5"))
        else:
            rating = float(own_stars[0].attrs.get("data-rating", 0)) if own_stars else sum(1 for n in stars if n.has_class("full") or n.has_class("p10")) + sum(.5 for n in stars if n.has_class("half") or n.has_class("p5"))
        full_review = fields["review"].find(lambda n: n.attrs.get("id") == "freeTextreview" + review_id)
        review_text = (full_review[0] if full_review else fields["review"]).prose().strip()
        if review_text == "None":
            review_text = ""
        dates = {}
        for key in ("date_started", "date_read"):
            entries = fields[key].find(lambda n: n.has_class("editable_date"))
            dates[key] = [parse_date(n.text()) for n in entries] if entries else [parse_date(text(key))]
        records.append({
            "goodreads_book_id": book_id, "goodreads_review_id": review_id,
            "book_url": "https://www.goodreads.com" + book_url,
            "title": book_links[0].attrs.get("title") or text("title"),
            "author": text("author").rstrip(" *"), "shelves": shelves or [],
            "rating": rating or None,
            "review_text": review_text,
            "review_url": "https://www.goodreads.com/review/show/" + review_id,
            "comment_count": int(text("comments") or 0),
            "like_count": int(text("votes") or 0),
            "cover_url": images[0].attrs.get("src") if images else None,
            "dates": {**dates, "date_added": parse_date(text("date_added"))},
            "fields": {key: text(key) for key in ("isbn", "isbn13", "asin", "num_pages", "avg_rating", "num_ratings", "date_pub", "date_pub_edition", "review", "notes", "read_count", "owned", "format")},
        })
    expected = int(expected_match[1].replace(",", ""))
    if (not partial and len(records) != expected) or len({r["goodreads_review_id"] for r in records}) != len(records):
        raise ValueError(f"Incomplete or duplicate table: expected {expected}, got {len(records)}. Select 100 per page; larger libraries need pagination support.")
    if not partial and memberships is not None and set(memberships) != {r["goodreads_review_id"] for r in records}:
        raise ValueError("Membership IDs do not exactly match saved table")
    return {"schema_version": 2, "source": "goodreads", "goodreads_user_id": user_id, "name": name, "expected_books": expected, "records": records}


def extract_pages(sources, user_id, name, memberships=None, allow_unassigned=False, friend_default_status=None):
    pages = [extract(s, user_id, name, memberships, partial=True, friend_default_status=friend_default_status) for s in sources]
    if not pages or len({p["expected_books"] for p in pages}) != 1:
        raise ValueError("Missing pages or inconsistent library totals")
    records = [r for p in pages for r in p["records"]]
    ids = [r["goodreads_review_id"] for r in records]
    if len(ids) != len(set(ids)) or len(ids) != pages[0]["expected_books"]:
        raise ValueError("Incomplete or overlapping pagination captures")
    if not allow_unassigned and memberships is not None and (set(memberships) != set(ids) or any(not r["shelves"] for r in records)):
        raise ValueError("Membership IDs do not exactly match saved library")
    return {**pages[0], "records": records}


def shelf_memberships(captures, user_id):
    result = {}
    for shelf, sources in captures.items():
        for source in sources:
            root = Document(source).root
            headings = root.find(lambda n: n.tag == "h1")
            links = [n for h in headings for n in h.find(lambda n: n.tag == "a")]
            queries = [parse_qs(urlparse(n.attrs.get("href", "")).query) for n in links]
            if not any(shelf in q.get("shelf", []) or shelf in q.get("tag", []) for q in queries):
                raise ValueError("Capture does not belong to requested shelf: " + shelf)
        data = extract_pages(sources, user_id, shelf, {}, allow_unassigned=True)
        for record in data["records"]:
            result.setdefault(record["goodreads_review_id"], []).append(shelf)
    return result


def extract_review(source, user_id, review_id):
    """Parse an authenticated review-page capture, including discussion and history."""
    root = Document(source).root
    authors = root.find(lambda n: n.tag == "a" and n.has_class("userReview"))
    if len(authors) != 1 or not re.search(rf"/user/show/{re.escape(user_id)}(?:[-/?#]|$)", authors[0].attrs.get("href", "")):
        raise ValueError("Review author does not match requested subject")
    if not root.find(lambda n: n.attrs.get("id") == "like_container_review_" + review_id):
        raise ValueError("Review ID does not match capture")
    comments = []
    for comment in root.find(lambda n: n.has_class("comment") and n.attrs.get("id", "").startswith("comment_")):
        author = comment.find(lambda n: n.has_class("commentAuthor"))[0]
        link = author.find(lambda n: n.tag == "a")[0]
        date_node = comment.find(lambda n: n.has_class("right") and "title" in n.attrs)[0]
        body = comment.find(lambda n: n.has_class("reviewText"))[0]
        comments.append({"id": comment.attrs["id"], "author": clean(author.text()), "author_url": link.attrs["href"], "date": date_node.attrs["title"], "body": body.prose().strip()})
    headings = root.find(lambda n: n.tag == "h2" and "Comments" in n.text())
    count = re.search(r"Showing\s+\d+-\d+\s+of\s+(\d+)", headings[0].text()) if headings else None
    if count and int(count[1]) != len(comments):
        raise ValueError("Comment pagination is incomplete")
    dates = root.find(lambda n: n.attrs.get("itemprop") == "datePublished")
    rating = root.find(lambda n: n.tag == "meta" and n.attrs.get("itemprop") == "ratingValue")
    history = []
    for row in root.find(lambda n: n.has_class("readingTimeline__row")):
        history.append({"text": clean(row.text()), "links": [{"text": clean(n.text()), "url": n.attrs["href"]} for n in row.find(lambda n: n.tag == "a")]})
    return {"goodreads_review_id": review_id, "goodreads_user_id": user_id, "source_url": "https://www.goodreads.com/review/show/" + review_id, "review_published": clean(dates[0].text()) if dates else None, "rating": float(rating[0].attrs["content"]) if rating else None, "reading_history": history, "comments": comments}


def summary(data):
    return {"name": data["name"], "books": len(data["records"]), "shelves": dict(Counter(s for r in data["records"] for s in r["shelves"])), "with_start_dates": sum(any(d is not None for d in r["dates"]["date_started"]) for r in data["records"]), "with_finish_dates": sum(any(d is not None for d in r["dates"]["date_read"]) for r in data["records"])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("html", type=Path, nargs="+")
    parser.add_argument("--user-id", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--memberships", type=Path)
    parser.add_argument("--friend-default-status", choices=("want", "reading", "did-not-finish"), help="For a friend-view capture, use this status where Goodreads does not expose the subject's shelf; dated/read-count books are marked read.")
    parser.add_argument("--shelf", nargs=2, action="append", metavar=("NAME", "HTML"), help="Repeat for every page of every shelf, including custom shelves")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    memberships = json.loads(args.memberships.read_text()) if args.memberships else None
    if args.shelf:
        if memberships is not None:
            parser.error("Use --shelf or --memberships, not both")
        captures = {}
        for shelf, path in args.shelf:
            captures.setdefault(shelf, []).append(Path(path).read_text())
        memberships = shelf_memberships(captures, args.user_id)
    if args.friend_default_status and memberships is not None:
        parser.error("Use --friend-default-status or memberships, not both")
    data = extract_pages([p.read_text() for p in args.html], args.user_id, args.name, memberships, friend_default_status=args.friend_default_status)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    args.output.chmod(0o600)
    print(json.dumps(summary(data), indent=2))


if __name__ == "__main__":
    main()
