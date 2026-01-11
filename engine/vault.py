# engine/vault.py
# Handles PDF ingestion and stores them in the database.

import os
import chromadb
from chromadb.utils import embedding_functions
from pypdf import PdfReader

# Set up the database
DB_DIR = os.path.join(os.path.dirname(__file__), "chroma_db")
client = chromadb.PersistentClient(path=DB_DIR)

# Set up the embedding model
embed_fn = embedding_functions.SentenceTransformerEmbeddingFunction(
    model_name="all-MiniLM-L6-v2"
)

# Get (or create if doesn't exist) the collection
collection = client.get_or_create_collection(
    name="user_knowledge",
    embedding_function=embed_fn
)

def ingest_pdf(file_path):
    """
    Reads a PDF, splits it into chunks, and saves it to the vector DB
    """
    print(f"Reading {file_path}")

    if not os.path.exists(file_path):
        print("FILE NOT FOUND!!")
        return
    
    reader = PdfReader(file_path)
    text_chunks = []
    metadatas = []
    ids = []

    # Each page is a chunk
    # TODO: add sliding window protocol
    for i, page in enumerate(reader.pages):
        text = page.extract_text()
        if text: 
            # Add to lists
            text_chunks.append(text)
            metadatas.append({"source": file_path, "page": i + 1})
            ids.append(f"{os.path.basename(file_path)}_page_{i}")

    if not text_chunks:
        print("NO TEXT FOUND IN PDF!!")
        return
    
    print(f"GENERATING EMBEDDINGS FOR {len(text_chunks)} PAGES")

    # Store in chromaDB
    collection.add(
        documents=text_chunks,
        metadatas=metadatas,
        ids=ids
    )
    print("SUCCESS!! DATA STORED SUCCESSFULLY")


# TEST
if __name__ == "__main__":
    test_pdf = "test_notes.pdf"
    
    if os.path.exists(test_pdf):
        ingest_pdf(test_pdf)
    else:
        print(f"PLACE A FILE NAMED {test_pdf} IN THIS FOLDER!!")
