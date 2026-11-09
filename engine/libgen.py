import sys
import json
from urllib.parse import urlparse

from libgen_api_enhanced import LibgenSearch, SearchTopic
from libgen_api_enhanced.book import Book

TOPICS = {
    "libgen": SearchTopic.LIBGEN,
    "fiction": SearchTopic.FICTION,
    "comics": SearchTopic.COMICS,
    "articles": SearchTopic.ARTICLES,
    "magazines": SearchTopic.MAGAZINES,
    "fiction_rus": SearchTopic.FICTION_RUS,
    "standards": SearchTopic.STANDARDS,
}

def serialize(book):
    fields = [
        "id", "title", "author", "publisher", "year",
        "language", "pages", "size", "extension", "md5",
        "date_added", "date_last_modified"
    ]

    result = {}

    for field in fields:
        value = getattr(book, field, None)
        if value is not None:
            result[field] = str(value)

    mirrors = getattr(book, "mirrors", None)
    if mirrors:
        result["mirrors"] = [
            str(m) for m in mirrors
            if m and urlparse(str(m)).scheme in ("http", "https")
        ]

    result["source"] = "libgen"
    return result


def resolve(request):
    md5 = str(request.get("md5", "")).strip().lower()
    mirrors = [
        str(mirror).strip()
        for mirror in request.get("mirrors", [])
        if isinstance(mirror, str) and mirror.strip()
    ]

    if not md5:
        raise ValueError("A book md5 is required to resolve a download link")
    if not mirrors:
        raise ValueError("This book has no mirror to resolve a download link from")

    book = Book(
        id="",
        title="",
        author="",
        publisher="",
        year="",
        language="",
        pages="",
        size="",
        extension="epub",
        md5=md5,
        mirrors=mirrors,
        cover_url=None,
        date_added="",
        date_last_modified="",
    )
    book.resolve_direct_download_link()

    url = book.resolved_download_link
    if not url:
        raise ValueError("The mirror page did not yield a direct download link")

    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("The resolved download URL is not valid")

    return {"url": url, "md5": md5}

def main():
    request = json.loads(sys.stdin.read())
    action = request.get("action", "search")

    if action == "resolve":
        print(json.dumps(resolve(request)))
        return

    query = request.get("query", "").strip()
    mode = request.get("mode", "default")
    page = max(1, int(request.get("page", 1)))

    topic_names = request.get("topics", ["libgen"])
    topics = [TOPICS[t] for t in topic_names if t in TOPICS]

    if not topics:
        topics = [SearchTopic.LIBGEN]

    searcher = LibgenSearch()

    if mode == "title":
        books = searcher.search_title(
            query, search_in=topics, page=page, add_upload_info=True
        )
    elif mode == "author":
        books = searcher.search_author(
            query, search_in=topics, page=page, add_upload_info=True
        )
    else:
        books = searcher.search_default(
            query, search_in=topics, page=page, add_upload_info=True
        )

    # Curated fresh out of the engine: only EPUB books with a usable mirror row.
    books = [
        book for book in books
        if str(getattr(book, "extension", "") or "").strip().lower() == "epub"
        and getattr(book, "mirrors", None)
    ]

    print(json.dumps({
        "results": [serialize(book) for book in books],
        "page": page
    }))

if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(1)
