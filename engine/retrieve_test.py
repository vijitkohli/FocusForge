# engine/retrieve_test.py

import os
import chromadb
from chromadb.utils import embedding_functions

# 1. CONNECT TO THE SAME DATABASE
# We point to the exact same folder where we saved the data
DB_DIR = os.path.join(os.path.dirname(__file__), "chroma_db")
client = chromadb.PersistentClient(path=DB_DIR)

# 2. LOAD THE EMBEDDING FUNCTION
# We must use the SAME model we used to ingest.
embed_fn = embedding_functions.SentenceTransformerEmbeddingFunction(
    model_name="all-MiniLM-L6-v2"
)

# 3. GET THE COLLECTION
collection = client.get_collection(
    name="user_knowledge",
    embedding_function=embed_fn
)

def query_vault(question):
    print(f"\n🔍 Question: '{question}'")
    
    # 4. PERFORM THE SEARCH
    # n_results=3 means "Give me the top 3 most relevant pages"
    results = collection.query(
        query_texts=[question],
        n_results=3
    )
    
    # 5. PRINT THE RESULTS
    # Chroma returns a confusing dictionary. We clean it up here.
    for i, doc in enumerate(results['documents'][0]):
        metadata = results['metadatas'][0][i]
        print(f"\n--- [Result {i+1}] (Source: {metadata['source']}, Page {metadata['page']}) ---")
        
        # Print just the first 300 characters so we don't flood the terminal
        preview = doc[:300].replace('\n', ' ')
        print(f"{preview}...")

if __name__ == "__main__":
    # CHANGE THIS to a question relevant to your PDF!
    # Example: "What is the handshake protocol?" or "How does TCP work?"
    my_question = "What is the internet?"
    
    query_vault(my_question)