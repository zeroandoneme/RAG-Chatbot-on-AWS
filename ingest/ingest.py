#!/usr/bin/env python3
import logging

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)

try:
    from flask import Flask, jsonify, request
    import os
    from dotenv import load_dotenv
    from langchain.vectorstores import OpenSearchVectorSearch
    from utils import (
        download_s3_folder,
        process_documents,
        opensearch_exists,
        get_param,
        delete_folder_contents,
        get_embeddings
    )

    logging.info("All imports ok ...")
except Exception as e:
    logging.error(f"Error Imports : {e} ")

app = Flask(__name__)

load_dotenv()


@app.route('/invocations', methods=['POST'])
def ingest():
    logging.info('Endpoint Invoked')
    data = request.get_json()
    index = data.get('index')
    bucket = data.get('bucket')
    key = data.get('key')

    # Loading embeddings model from Hugging Face
    embeddings = get_embeddings()

    # Load required parameters for opensearch
    auth, endpoint = get_param()

    # Download documents into source_documents folder
    directory = 'source_documents'
    download_s3_folder(bucket, key, directory)

    # Load documents and process
    texts = process_documents(directory)
    try:
        # Uploading new documents to opensearch
        logging.info('Ingestion Started....')
        OpenSearchVectorSearch.from_documents(
            index_name=index,
            documents=texts,
            embedding=embeddings,
            # opensearch_url=endpoint,
            opensearch_url='https://' + endpoint,
            bulk_size=30000,
            http_auth=auth
        )
        message = "Ingestion complete!"
        delete_folder_contents(directory)
        return jsonify(message=message, status="Success"), 200
    except Exception as e:
        logging.error(f'An error occured while ingesting {e}')
        return jsonify(message=str(e), status="Failed"), 500


@app.route('/ping', methods=['GET'])
def ping():
    return "pinged", 200


@app.route('/', methods=['GET'])
def health_check():
    return "pinged", 200


if __name__ == "__main__":
    load_dotenv()

    app.run(
        host='0.0.0.0',
        port=8080,
    )
