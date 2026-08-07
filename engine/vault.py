# engine/vault.py
# Reusable PDF extraction + relevance-filtering helpers used by the live
# pipeline (engine/extract.py): extract_pages() reads a PDF, relevant_chunks()
# embeds it into a transient Chroma collection and returns the top matches,
# then drops the collection so unrelated documents never mix.

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
