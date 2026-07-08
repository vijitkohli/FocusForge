# engine/vault.py
# Reusable PDF extraction + relevance-filtering helpers.
# The standalone __main__ path below still demonstrates ingestion into the
# permanent "user_knowledge" collection, but engine/extract.py (the live
# pipeline) uses extract_pages()/relevant_chunks() against a transient
# collection instead, so unrelated documents never mix.

import os
import uuid
import chromadb
from chromadb.utils import embedding_functions
from pypdf import PdfReader

DB_DIR = os.path.join(os.path.dirname(__file__), "chroma_db")

_embed_fn = embedding_functions.SentenceTransformerEmbeddingFunction(
    model_name="all-MiniLM-L6-v2"
)


def extract_pages(file_path):
    """
    Reads a PDF and returns a list of per-page text chunks (non-empty pages only).
    """
    if not os.path.exists(file_path):
        raise FileNotFoundError(file_path)

    reader = PdfReader(file_path)
    pages = []
    for page in reader.pages:
        text = page.extract_text()
        if text:
            pages.append(text)
    return pages


def relevant_chunks(pages, query, n=5):
    """
    Embeds `pages` into a transient, in-memory-only-for-this-call Chroma
    collection, queries by `query`, returns the top-n most relevant chunks,
    then drops the collection so nothing persists across calls.
    """
    if not pages:
        return []

    client = chromadb.PersistentClient(path=DB_DIR)
    collection_name = f"tmp_{uuid.uuid4().hex}"
    collection = client.create_collection(
        name=collection_name,
        embedding_function=_embed_fn
    )

    try:
        collection.add(
            documents=pages,
            ids=[f"page_{i}" for i in range(len(pages))]
        )
        results = collection.query(
            query_texts=[query],
            n_results=min(n, len(pages))
        )
        return results["documents"][0]
    finally:
        client.delete_collection(collection_name)


def ingest_pdf(file_path):
    """
    Reads a PDF and saves it permanently to the shared "user_knowledge"
    collection. Standalone/manual use only - not part of the live pipeline.
    """
    print(f"Reading {file_path}")

    try:
        pages = extract_pages(file_path)
    except FileNotFoundError:
        print("FILE NOT FOUND!!")
        return

    if not pages:
        print("NO TEXT FOUND IN PDF!!")
        return

    print(f"GENERATING EMBEDDINGS FOR {len(pages)} PAGES")

    client = chromadb.PersistentClient(path=DB_DIR)
    collection = client.get_or_create_collection(
        name="user_knowledge",
        embedding_function=_embed_fn
    )
    collection.add(
        documents=pages,
        metadatas=[{"source": file_path, "page": i + 1} for i in range(len(pages))],
        ids=[f"{os.path.basename(file_path)}_page_{i}" for i in range(len(pages))]
    )
    print("SUCCESS!! DATA STORED SUCCESSFULLY")


if __name__ == "__main__":
    test_pdf = "test_notes.pdf"

    if os.path.exists(test_pdf):
        ingest_pdf(test_pdf)
    else:
        print(f"PLACE A FILE NAMED {test_pdf} IN THIS FOLDER!!")
