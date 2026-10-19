import {
  BookOpen,
  Sparkles,
  Database,
  RefreshCw,
  ShieldCheck,
  ArrowLeft,
  ExternalLink,
  GraduationCap,
  Users,
  Compass,
  Library,
  Layers,
  Code2,
  Heart,
  FileText,
  CheckCircle2,
} from "lucide-react";
import "./about.css";

import { useState, useEffect } from "react";

type LegalTab = "overview" | "privacy" | "terms" | "support";

function detectLegalTab(): LegalTab {
  if (typeof location === "undefined") return "overview";
  const path = location.pathname.toLowerCase();
  const hash = location.hash.toLowerCase();
  if (path.includes("privacy") || hash.includes("privacy")) return "privacy";
  if (
    path.includes("terms") ||
    path.includes("eula") ||
    hash.includes("terms") ||
    hash.includes("eula")
  )
    return "terms";
  if (path.includes("support") || hash.includes("support")) return "support";
  return "overview";
}

interface AboutPageProps {
  onBack?: () => void;
  isAuthenticated?: boolean;
  initialTab?: LegalTab;
}

export function AboutPage({
  onBack,
  isAuthenticated = false,
  initialTab,
}: AboutPageProps) {
  const [tab, setTab] = useState<LegalTab>(
    () => initialTab || detectLegalTab(),
  );

  useEffect(() => {
    const onHashOrUrlChange = () => {
      setTab(detectLegalTab());
    };
    window.addEventListener("hashchange", onHashOrUrlChange);
    window.addEventListener("popstate", onHashOrUrlChange);
    return () => {
      window.removeEventListener("hashchange", onHashOrUrlChange);
      window.removeEventListener("popstate", onHashOrUrlChange);
    };
  }, []);

  const switchTab = (nextTab: LegalTab) => {
    setTab(nextTab);
    const hash = nextTab === "overview" ? "about" : nextTab;
    if (location.hash !== `#${hash}`) {
      location.hash = hash;
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div className="about-page">
      {/* Navigation Header */}
      <header className="about-header">
        <div className="about-header-inner">
          <a
            href="/"
            className="about-brand"
            onClick={(e) => {
              if (onBack) {
                e.preventDefault();
                onBack();
              }
            }}
          >
            <img src="/logo.png" alt="whatchureading logo" />
            <span>
              whatchu<span>reading.</span>
            </span>
          </a>

          <div className="about-header-actions">
            <a
              href="https://github.com/ashayas/whatchureading"
              target="_blank"
              rel="noreferrer"
              className="about-gh-link"
              aria-label="View source code on GitHub"
            >
              <Code2 size={16} />
              <span>GitHub</span>
            </a>

            {onBack ? (
              <button type="button" className="about-cta-btn" onClick={onBack}>
                <ArrowLeft size={16} />
                <span>
                  {isAuthenticated ? "Back to library" : "Back to book"}
                </span>
              </button>
            ) : (
              <a href="/" className="about-cta-btn">
                <span>Start reading</span>
              </a>
            )}
          </div>
        </div>
      </header>

      {/* Subnavigation Bar */}
      <nav
        className="about-subnav"
        aria-label="About sections and legal documents"
      >
        <button
          type="button"
          className={`about-subnav-btn ${tab === "overview" ? "active" : ""}`}
          onClick={() => switchTab("overview")}
        >
          <BookOpen size={14} style={{ marginRight: 6, verticalAlign: -2 }} />
          About &amp; Architecture
        </button>
        <button
          type="button"
          className={`about-subnav-btn ${tab === "privacy" ? "active" : ""}`}
          onClick={() => switchTab("privacy")}
        >
          <ShieldCheck
            size={14}
            style={{ marginRight: 6, verticalAlign: -2 }}
          />
          Privacy Policy
        </button>
        <button
          type="button"
          className={`about-subnav-btn ${tab === "terms" ? "active" : ""}`}
          onClick={() => switchTab("terms")}
        >
          <FileText size={14} style={{ marginRight: 6, verticalAlign: -2 }} />
          Terms &amp; EULA
        </button>
        <button
          type="button"
          className={`about-subnav-btn ${tab === "support" ? "active" : ""}`}
          onClick={() => switchTab("support")}
        >
          <Users size={14} style={{ marginRight: 6, verticalAlign: -2 }} />
          Support &amp; Safety
        </button>
      </nav>

      {tab === "privacy" && (
        <div className="about-container">
          <article className="legal-article">
            <h2>Privacy Policy</h2>
            <div className="legal-meta">
              Effective Date: October 12, 2026 · whatchureading.com &amp; iOS
              Application
            </div>
            <div className="legal-body">
              <p>
                At <strong>whatchureading</strong>, we believe your reading life
                should remain calm, private, and entirely yours. We do not sell
                your personal information, we do not host third-party
                advertising, and we do not track your activity across other
                applications or services.
              </p>

              <h3>1. Information We Collect</h3>
              <p>
                We only collect the information necessary to provide the reading
                tracker and sync your library across devices:
              </p>
              <ul>
                <li>
                  <strong>Account Credentials:</strong> Your email address and
                  hashed passwords, managed securely through our standalone
                  authentication provider (Supabase Auth).
                </li>
                <li>
                  <strong>Profile Information:</strong> Your display name,
                  chosen username, reading goal, and optional profile avatar.
                </li>
                <li>
                  <strong>Reading Activity:</strong> Books you add to your
                  shelves (Reading, Want to Read, Read, Did Not Finish), page
                  progress, ratings, pairwise rankings, and margin thoughts.
                </li>
                <li>
                  <strong>Academic Papers:</strong> PDF preprints and research
                  articles you explicitly choose to upload to your personal
                  library.
                </li>
                <li>
                  <strong>Community Activity:</strong> Book club group
                  memberships, shared thoughts, and comments in groups you join.
                </li>
              </ul>

              <h3>2. How We Store and Protect Your Data</h3>
              <p>
                All application metadata, shelf statuses, and reading logs are
                stored in Cloudflare D1 distributed edge databases. Uploaded
                avatars and personal paper PDFs are stored encrypted in
                Cloudflare R2 object storage. All communications between client
                devices and our edge workers use TLS encryption.
              </p>

              <h3>3. Third-Party Services</h3>
              <ul>
                <li>
                  <strong>Open Library (Internet Archive):</strong> We query
                  public book metadata and cover images using Open Library's
                  public APIs. No personal user details are shared with Open
                  Library.
                </li>
                <li>
                  <strong>Supabase Auth:</strong> Handles identity verification
                  via standard PKCE bearer tokens. Supabase has no access to
                  your reading history or shelves.
                </li>
                <li>
                  <strong>Resend:</strong> Used solely to deliver transactional
                  email verification links.
                </li>
              </ul>

              <h3>4. Zero Advertising and No Cross-App Tracking</h3>
              <p>
                whatchureading does not include any third-party advertising
                SDKs, data brokers, or cross-site tracking tags. We do not
                request or utilize Apple's App Tracking Transparency (ATT)
                identifier (IDFA).
              </p>

              <h3>5. Self-Service Account and Data Deletion</h3>
              <p>
                In compliance with Apple App Store Review Guideline 5.1.1(v) and
                global privacy regulations, you have the right to delete your
                account and all associated data at any time. Inside the mobile
                app or web app under
                <strong>Profile &gt; Settings &gt; Delete Account</strong>,
                tapping Delete permanently erases all database rows (shelves,
                reviews, thoughts, group comments) and all uploaded files
                (avatars, PDFs) from our servers immediately.
              </p>

              <h3>6. Contact and Inquiries</h3>
              <p>
                If you have questions about your data or wish to submit a
                privacy request, please contact us at{" "}
                <a href="mailto:privacy@whatchureading.com">
                  privacy@whatchureading.com
                </a>{" "}
                or{" "}
                <a href="mailto:ashaya@whatchureading.com">
                  ashaya@whatchureading.com
                </a>
                .
              </p>
            </div>
          </article>
        </div>
      )}

      {tab === "terms" && (
        <div className="about-container">
          <article className="legal-article">
            <h2>Terms of Service &amp; End User License Agreement (EULA)</h2>
            <div className="legal-meta">
              Effective Date: October 12, 2026 · whatchureading.com &amp; iOS
              Application
            </div>
            <div className="legal-body">
              <p>
                These Terms of Service and End User License Agreement
                (&ldquo;EULA&rdquo;) constitute a binding agreement between you
                and <strong>whatchureading</strong> (&ldquo;we&rdquo;,
                &ldquo;us&rdquo;, or &ldquo;our&rdquo;) governing your use of
                the whatchureading website and iOS mobile application.
              </p>

              <h3>1. License Grant</h3>
              <p>
                We grant you a revocable, non-exclusive, non-transferable,
                limited license to download, install, and use the whatchureading
                mobile application on Apple iOS devices that you own or control,
                strictly in accordance with these Terms and the Apple Media
                Services Terms and Conditions.
              </p>

              <div className="legal-callout">
                <strong>
                  Apple App Store Guideline 1.2 — User-Generated Content &amp;
                  Safety:
                </strong>
                <br />
                whatchureading maintains a <em>
                  strict zero-tolerance policy
                </em>{" "}
                for objectionable content, abusive behavior, harassment, or hate
                speech. You must agree to these standards to use the service.
              </div>

              <h3>2. User-Generated Content (UGC) Standards</h3>
              <p>
                whatchureading permits users to post book thoughts, reviews,
                progress updates, and group discussion comments. You agree that
                you will NOT upload, post, or share any content that:
              </p>
              <ul>
                <li>
                  Is defamatory, obscene, pornographic, sexually explicit, or
                  violent.
                </li>
                <li>
                  Promotes discrimination, bigotry, racism, hatred, harassment,
                  or harm against any group or individual.
                </li>
                <li>
                  Infringes any patent, trademark, trade secret, copyright, or
                  other proprietary rights.
                </li>
                <li>
                  Contains spam, unsolicited advertising, or unauthorized
                  commercial solicitations.
                </li>
                <li>
                  Impersonates any person or entity or misrepresents your
                  affiliation.
                </li>
              </ul>

              <h3>3. Content Moderation, Reporting &amp; User Blocking</h3>
              <p>
                To protect our community, whatchureading provides built-in
                safety tools:
              </p>
              <ul>
                <li>
                  <strong>Content Reporting:</strong> Any user can immediately
                  flag or report any thought, review, or comment as
                  objectionable by selecting the &ldquo;Report&rdquo; option
                  directly on the item.
                </li>
                <li>
                  <strong>User Blocking:</strong> You can block any abusive user
                  directly from their profile or post menu. Blocking immediately
                  hides all content posted by that user from your feed, library,
                  and discussions.
                </li>
                <li>
                  <strong>24-Hour Moderation Action:</strong> Our moderation
                  team investigates all reports within 24 hours. Any user found
                  to have violated our zero-tolerance policy will have their
                  offending content removed immediately and their account
                  permanently ejected from the platform.
                </li>
              </ul>

              <h3>4. Ownership and License to Your Content</h3>
              <p>
                You retain complete intellectual property ownership of your
                original thoughts, reviews, and reading notes. By posting
                content, you grant whatchureading a non-exclusive license to
                store and transmit that content solely to provide the service in
                accordance with your chosen visibility settings (e.g. public vs.
                private notes).
              </p>

              <h3>5. Termination</h3>
              <p>
                You may terminate your account at any time using the
                self-service account deletion feature in the application. We
                reserve the right to suspend or terminate accounts that violate
                these Terms or pose a safety risk to other readers.
              </p>

              <h3>6. Disclaimer of Warranties</h3>
              <p>
                whatchureading is provided on an &ldquo;AS IS&rdquo; and
                &ldquo;AS AVAILABLE&rdquo; basis without warranties of any kind,
                either express or implied.
              </p>

              <h3>7. Moderation and Legal Contact</h3>
              <p>
                To submit an urgent safety or content report directly to our
                moderation team, please email{" "}
                <a href="mailto:moderation@whatchureading.com">
                  moderation@whatchureading.com
                </a>
                .
              </p>
            </div>
          </article>
        </div>
      )}

      {tab === "support" && (
        <div className="about-container">
          <article className="legal-article">
            <h2>Support &amp; Community Safety</h2>
            <div className="legal-meta">
              whatchureading Help Center &amp; Safety Resources
            </div>
            <div className="legal-body">
              <p>
                Need assistance with your reading library, mobile app sync, or
                have a safety inquiry? We are here to help.
              </p>

              <h3>Contact Support</h3>
              <ul>
                <li>
                  <strong>General Inquiries &amp; Help:</strong>{" "}
                  <a href="mailto:support@whatchureading.com">
                    support@whatchureading.com
                  </a>
                </li>
                <li>
                  <strong>Urgent Content Moderation &amp; Safety:</strong>{" "}
                  <a href="mailto:moderation@whatchureading.com">
                    moderation@whatchureading.com
                  </a>
                </li>
                <li>
                  <strong>Privacy &amp; Data Rights:</strong>{" "}
                  <a href="mailto:privacy@whatchureading.com">
                    privacy@whatchureading.com
                  </a>
                </li>
                <li>
                  <strong>Open Source GitHub Issues:</strong>{" "}
                  <a
                    href="https://github.com/ashayas/whatchureading/issues"
                    target="_blank"
                    rel="noreferrer"
                  >
                    github.com/ashayas/whatchureading/issues
                  </a>
                </li>
              </ul>

              <h3>Frequently Asked Questions</h3>
              <p>
                <strong>How do I import my books from Goodreads?</strong>
                <br />
                Go to Discover &gt; Import from Goodreads. We link you to
                Goodreads’ export page; upload the CSV it gives you, and your
                shelves, ratings, and reading dates will be mapped seamlessly.
              </p>

              <p>
                <strong>
                  How do I block an abusive user or report content?
                </strong>
                <br />
                On any note or comment in your feed or group, tap the three dots
                or flag icon and select &ldquo;Report Content&rdquo;. To block a
                user, open their profile and tap &ldquo;Block User&rdquo;.
                Content is reviewed within 24 hours.
              </p>

              <p>
                <strong>How do I delete my account?</strong>
                <br />
                Open your Profile, scroll down to the Danger Zone, and tap
                &ldquo;Delete Account&rdquo;. All your shelves, notes, progress,
                and uploaded files are deleted permanently and cannot be
                recovered.
              </p>
            </div>
          </article>
        </div>
      )}

      {tab === "overview" && (
        <>
          {/* Hero Section */}
          <section className="about-hero">
            <span className="about-eyebrow">
              <Sparkles size={14} /> A LITTLE LESS SCROLLING. A LITTLE MORE
              READING.
            </span>
            <h1>
              The calm, open-source home for your <em>reading life.</em>
            </h1>
            <p className="about-lead">
              No Amazon. No ads. No tracking algorithms. whatchureading is a
              free, open-source book tracking app and paper reader powered by
              Open Library data, built so you truly own every chapter.
            </p>

            <div className="about-badges">
              <span className="about-badge">
                <ShieldCheck size={15} /> 100% Free &amp; Open Source (MIT)
              </span>
              <span className="about-badge">
                <Database size={15} /> Open Library Edition Index
              </span>
              <span className="about-badge">
                <Sparkles size={15} /> Zero Ads or Affiliate Links
              </span>
              <span className="about-badge">
                <GraduationCap size={15} /> Research Papers Radar
              </span>
              <span className="about-badge">
                <RefreshCw size={15} /> Monthly Edge Sync
              </span>
            </div>
          </section>

          <div className="about-container">
            {/* Core Principles */}
            <section
              className="about-section"
              style={{ marginTop: 0, borderTop: "none" }}
            >
              <div className="about-section-header">
                <span className="about-section-tag">OUR PHILOSOPHY</span>
                <h2>Why whatchureading exists</h2>
                <p className="about-section-desc">
                  Most reading apps today are owned by giant retail
                  conglomerates incentivized to push Kindle purchases, display
                  targeted ads, or lock your data inside proprietary walls.
                  whatchureading takes a different path.
                </p>
              </div>

              <div className="about-grid-3">
                <div className="about-card">
                  <div className="about-card-icon">
                    <ShieldCheck size={22} />
                  </div>
                  <h3>You own your data</h3>
                  <p>
                    Your shelves, progress, and private margin notes belong
                    strictly to you. We provide self-service account deletion (
                    <code>DELETE /api/v1/account</code>) that immediately erases
                    all database rows and uploaded files with zero lock-in.
                  </p>
                </div>

                <div className="about-card">
                  <div className="about-card-icon">
                    <Sparkles size={22} />
                  </div>
                  <h3>Quiet, calm reading</h3>
                  <p>
                    No algorithmic rage-bait, no sponsored placements, and no
                    ads. Enjoy a peaceful editorial bookshop aesthetic crafted
                    for focus, reflection, and real conversations between the
                    pages.
                  </p>
                </div>

                <div className="about-card">
                  <div className="about-card-icon">
                    <GraduationCap size={22} />
                  </div>
                  <h3>Books and papers together</h3>
                  <p>
                    A modern reader’s curiosity isn't confined to paperbacks.
                    Upload research papers (PDFs) and visualize your
                    intellectual journey with client-side subtopic radar
                    analysis.
                  </p>
                </div>
              </div>
            </section>

            {/* Data Attribution & Sources */}
            <section className="about-section" id="attribution">
              <div className="about-section-header">
                <span className="about-section-tag">
                  DATA SOURCES & ATTRIBUTION
                </span>
                <h2>Where we get the data</h2>
                <p className="about-section-desc">
                  whatchureading is built on the shoulders of the open web and
                  non-profit knowledge preservation. Here is full credit and
                  attribution for the datasets that make this platform possible.
                </p>
              </div>

              <div className="attribution-card">
                <div className="attribution-org">
                  <div className="attribution-org-title">
                    <BookOpen size={24} style={{ color: "#203e35" }} />
                    <div>
                      <h3>Open Library & The Internet Archive</h3>
                      <small style={{ color: "#63776b" }}>
                        Primary Book Catalog, Works & Editions
                      </small>
                    </div>
                  </div>
                  <div className="attribution-links">
                    <a
                      href="https://openlibrary.org"
                      target="_blank"
                      rel="noreferrer"
                      className="attribution-link"
                    >
                      openlibrary.org <ExternalLink size={13} />
                    </a>
                    <a
                      href="https://archive.org"
                      target="_blank"
                      rel="noreferrer"
                      className="attribution-link"
                    >
                      archive.org <ExternalLink size={13} />
                    </a>
                  </div>
                </div>

                <p
                  style={{
                    margin: "0 0 16px",
                    color: "#3e4d44",
                    fontSize: "15px",
                    lineHeight: "1.65",
                  }}
                >
                  All book titles, ISBNs, authors, publish dates, and edition
                  metadata in whatchureading are sourced directly from{" "}
                  <strong>Open Library</strong>, an open, editable library
                  catalog project of the <strong>Internet Archive</strong> (a
                  501(c)(3) non-profit digital library).
                </p>

                <p
                  style={{
                    margin: "0 0 16px",
                    color: "#3e4d44",
                    fontSize: "15px",
                    lineHeight: "1.65",
                  }}
                >
                  We are profoundly grateful to the Open Library team and the
                  thousands of librarians and contributors worldwide who
                  tirelessly compile and preserve bibliographic data for
                  universal public benefit under open licenses.
                </p>

                <div
                  style={{
                    display: "flex",
                    gap: "10px",
                    flexWrap: "wrap",
                    marginTop: "16px",
                  }}
                >
                  <span className="tech-pill">
                    <CheckCircle2 size={13} style={{ color: "#4a7263" }} /> Bulk
                    Data Dumps (Monthly)
                  </span>
                  <span className="tech-pill">
                    <CheckCircle2 size={13} style={{ color: "#4a7263" }} /> Open
                    Library Covers CDN
                  </span>
                  <span className="tech-pill">
                    <CheckCircle2 size={13} style={{ color: "#4a7263" }} />{" "}
                    Works & Editions Mapping
                  </span>
                </div>
              </div>

              <div className="about-grid-2">
                <div className="about-card">
                  <div className="about-card-icon">
                    <Library size={22} />
                  </div>
                  <h3>Open Library Covers API</h3>
                  <p>
                    Cover images are retrieved dynamically from the Open Library
                    Covers CDN (<code>covers.openlibrary.org</code>) and cached
                    for edge delivery. Readers can also upload custom cover
                    artwork, which is stored securely in isolated Cloudflare R2
                    object storage.
                  </p>
                </div>

                <div className="about-card">
                  <div className="about-card-icon">
                    <FileText size={22} />
                  </div>
                  <h3>Open Research & arXiv Preprints</h3>
                  <p>
                    For academic reading, readers can upload open-access papers
                    (such as preprints from arXiv.org) or personal documents.
                    The in-browser text engine parses text locally without
                    sending your paper's content to third-party AI models.
                  </p>
                </div>
              </div>
            </section>

            {/* The Monthly Sync Job */}
            <section className="about-section" id="sync">
              <div className="about-section-header">
                <span className="about-section-tag">ENGINEERING DEEP DIVE</span>
                <h2>The Monthly Open Library Sync</h2>
                <p className="about-section-desc">
                  Rather than hitting Open Library's public search API on every
                  reader query (which is slow and taxes their non-profit
                  servers), whatchureading owns an independent, lightweight
                  edition index at the edge. Here is how it works:
                </p>
              </div>

              <div className="sync-flow">
                <div className="sync-flow-header">
                  <h3>Automated Monthly Edge Ingestion Pipeline</h3>
                  <p style={{ margin: 0, color: "#55665d", fontSize: "14px" }}>
                    Scheduled via GitHub Actions on the 11th of each month (with
                    a 10-day buffer after Open Library's dump publication).
                  </p>
                </div>

                <div className="sync-steps">
                  <div className="sync-step">
                    <span className="sync-step-num">1</span>
                    <h4>Stream & Filter</h4>
                    <p>
                      Streams Open Library's multi-gigabyte edition dump (
                      <code>ol_dump_editions_latest.txt.gz</code>), filtering
                      down to English titles with valid ISBNs.
                    </p>
                  </div>

                  <div className="sync-step">
                    <span className="sync-step-num">2</span>
                    <h4>Flatten & Fingerprint</h4>
                    <p>
                      Each edition is flattened to a compact record (
                      <code>id, work_key, isbn, title, author, pages</code>)
                      with a SHA-1 fingerprint.
                    </p>
                  </div>

                  <div className="sync-step">
                    <span className="sync-step-num">3</span>
                    <h4>Diff Against R2 Snapshot</h4>
                    <p>
                      Walks this month's rows against last month's compressed
                      snapshot stored in Cloudflare R2. Unchanged rows are
                      skipped entirely.
                    </p>
                  </div>

                  <div className="sync-step">
                    <span className="sync-step-num">4</span>
                    <h4>Batch Write to D1</h4>
                    <p>
                      Applies only net changes (new or modified editions) into
                      the dedicated Cloudflare D1 database (
                      <code>whatchureading-openlibrary</code>).
                    </p>
                  </div>
                </div>

                <div className="sync-callout">
                  <strong>
                    💡 Total Isolation &amp; Zero Impact on Readers:
                  </strong>{" "}
                  The edition index lives in its own D1 database and R2 bucket,
                  completely separated from the app's primary user database (
                  <code>whatchureading-db</code>). Wiping or rebuilding the
                  index never touches reader shelves or personal notes. Because
                  only delta rows are written, ongoing monthly operations cost
                  $0–5 within Cloudflare and GitHub free tiers.
                </div>
              </div>
            </section>

            {/* Feature Tour */}
            <section className="about-section" id="features">
              <div className="about-section-header">
                <span className="about-section-tag">FEATURES AT A GLANCE</span>
                <h2>Built for readers, not algorithms</h2>
                <p className="about-section-desc">
                  Everything you need to track your reading journey, reflect on
                  thoughts, and connect with friends.
                </p>
              </div>

              <div className="about-grid-3">
                <div className="about-card">
                  <div className="about-card-icon">
                    <Library size={22} />
                  </div>
                  <h3>Four-State Shelves</h3>
                  <p>
                    Track books as <em>Currently Reading</em> (with exact page
                    logs &amp; percentage bars), <em>Want to Read</em>,{" "}
                    <em>Read</em>, or <em>Did Not Finish (DNF)</em> without
                    guilt.
                  </p>
                </div>

                <div className="about-card">
                  <div className="about-card-icon">
                    <FileText size={22} />
                  </div>
                  <h3>Margin Notes &amp; Thoughts</h3>
                  <p>
                    Record thoughts, memorable quotes, and reflections as you
                    turn the page. Choose whether each note is shared with
                    friends or saved as a private reflection.
                  </p>
                </div>

                <div className="about-card">
                  <div className="about-card-icon">
                    <GraduationCap size={22} />
                  </div>
                  <h3>The Papers Radar</h3>
                  <p>
                    Built-in browser PDF viewer with interactive subtopic radar
                    mapping across Computer Science, Physics, Life Sciences,
                    Economics, Social Sciences, and Humanities.
                  </p>
                </div>

                <div className="about-card">
                  <div className="about-card-icon">
                    <Users size={22} />
                  </div>
                  <h3>Book Clubs &amp; Groups</h3>
                  <p>
                    Start a reading club with friends. Pick your group's current
                    book, track everyone's individual reading progress, and
                    discuss chapters together.
                  </p>
                </div>

                <div className="about-card">
                  <div className="about-card-icon">
                    <Compass size={22} />
                  </div>
                  <h3>Book Matchmaker</h3>
                  <p>
                    A delightful, low-pressure swipe interface ("Book Tinder")
                    to flip through curated titles and quickly add promising
                    discoveries to your wishlist.
                  </p>
                </div>

                <div className="about-card">
                  <div className="about-card-icon">
                    <RefreshCw size={22} />
                  </div>
                  <h3>Goodreads Importer</h3>
                  <p>
                    Rescue your entire reading history in seconds. We link you
                    straight to Goodreads’ export page; drop in the CSV and you
                    never hand your credentials to anyone.
                  </p>
                </div>
              </div>
            </section>

            {/* Tech Stack & Architecture */}
            <section className="about-section" id="stack">
              <div className="about-section-header">
                <span className="about-section-tag">
                  OPEN SOURCE ARCHITECTURE
                </span>
                <h2>Modern edge technology</h2>
                <p className="about-section-desc">
                  whatchureading is engineered for speed, low latency, and zero
                  bloat.
                </p>
              </div>

              <div className="about-card" style={{ padding: "32px" }}>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                    gap: "24px",
                  }}
                >
                  <div>
                    <h4
                      style={{
                        margin: "0 0 6px",
                        fontSize: "16px",
                        color: "#1a2f28",
                      }}
                    >
                      Backend
                    </h4>
                    <p
                      style={{ margin: 0, fontSize: "14px", color: "#4b5a51" }}
                    >
                      Rust compiled to WebAssembly running on Cloudflare Workers
                      (<code>worker-build</code>).
                    </p>
                  </div>

                  <div>
                    <h4
                      style={{
                        margin: "0 0 6px",
                        fontSize: "16px",
                        color: "#1a2f28",
                      }}
                    >
                      Database
                    </h4>
                    <p
                      style={{ margin: 0, fontSize: "14px", color: "#4b5a51" }}
                    >
                      Cloudflare D1 (distributed SQLite at the edge) with
                      isolated catalog &amp; user databases.
                    </p>
                  </div>

                  <div>
                    <h4
                      style={{
                        margin: "0 0 6px",
                        fontSize: "16px",
                        color: "#1a2f28",
                      }}
                    >
                      Storage
                    </h4>
                    <p
                      style={{ margin: 0, fontSize: "14px", color: "#4b5a51" }}
                    >
                      Cloudflare R2 object storage for custom cover artwork,
                      user avatars, and uploaded PDFs.
                    </p>
                  </div>

                  <div>
                    <h4
                      style={{
                        margin: "0 0 6px",
                        fontSize: "16px",
                        color: "#1a2f28",
                      }}
                    >
                      Frontend
                    </h4>
                    <p
                      style={{ margin: 0, fontSize: "14px", color: "#4b5a51" }}
                    >
                      React 19, TypeScript, Vite, and native CSS variables for
                      instant responsiveness.
                    </p>
                  </div>
                </div>

                <div
                  style={{
                    marginTop: "24px",
                    paddingTop: "20px",
                    borderTop: "1px solid #e5eade",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: "16px",
                  }}
                >
                  <div
                    style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}
                  >
                    <span className="tech-pill">MIT Licensed</span>
                    <span className="tech-pill">No Telemetry / No Ads</span>
                    <span className="tech-pill">Self-Hostable</span>
                  </div>

                  <a
                    href="https://github.com/ashayas/whatchureading"
                    target="_blank"
                    rel="noreferrer"
                    className="about-gh-link"
                  >
                    <Code2 size={16} />
                    <span>View Repository on GitHub</span>
                    <ExternalLink size={13} />
                  </a>
                </div>
              </div>
            </section>
          </div>
        </>
      )}

      {/* Footer */}
      <div className="about-container">
        <footer className="about-footer">
          <p>
            whatchureading is an independent open-source project created with{" "}
            <Heart
              size={14}
              style={{
                display: "inline",
                verticalAlign: "middle",
                color: "#a4453a",
              }}
            />{" "}
            by{" "}
            <a href="https://x.com/ashaya" target="_blank" rel="noreferrer">
              @ashaya
            </a>
            .
          </p>
          <p style={{ fontSize: "13px", color: "#7a8a81" }}>
            Not affiliated with, endorsed by, or sponsored by Amazon.com or
            Goodreads. Open Library data is provided under open public licenses
            by the Internet Archive.
          </p>
          <p
            style={{
              marginTop: "16px",
              display: "flex",
              justifyContent: "center",
              gap: "10px",
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <a href="/">Home</a> ·{" "}
            <button
              type="button"
              className="about-footer-link"
              onClick={() => switchTab("overview")}
              style={{
                background: "none",
                border: "none",
                color: "#203e35",
                textDecoration: "underline",
                cursor: "pointer",
                font: "inherit",
              }}
            >
              About &amp; Architecture
            </button>{" "}
            ·{" "}
            <button
              type="button"
              className="about-footer-link"
              onClick={() => switchTab("privacy")}
              style={{
                background: "none",
                border: "none",
                color: "#203e35",
                textDecoration: "underline",
                cursor: "pointer",
                font: "inherit",
              }}
            >
              Privacy Policy
            </button>{" "}
            ·{" "}
            <button
              type="button"
              className="about-footer-link"
              onClick={() => switchTab("terms")}
              style={{
                background: "none",
                border: "none",
                color: "#203e35",
                textDecoration: "underline",
                cursor: "pointer",
                font: "inherit",
              }}
            >
              Terms &amp; EULA
            </button>{" "}
            ·{" "}
            <button
              type="button"
              className="about-footer-link"
              onClick={() => switchTab("support")}
              style={{
                background: "none",
                border: "none",
                color: "#203e35",
                textDecoration: "underline",
                cursor: "pointer",
                font: "inherit",
              }}
            >
              Support &amp; Safety
            </button>{" "}
            ·{" "}
            <a
              href="https://github.com/ashayas/whatchureading"
              target="_blank"
              rel="noreferrer"
            >
              GitHub
            </a>
          </p>
        </footer>
      </div>
    </div>
  );
}
export default AboutPage;
