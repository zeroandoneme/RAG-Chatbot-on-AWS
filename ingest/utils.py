#!/usr/bin/env python3
try:
    import logging
    import os
    import glob
    from botocore.exceptions import ClientError
    from dotenv import load_dotenv
    from multiprocessing import Pool
    from tqdm import tqdm
    import boto3
    import shutil
    from langchain.text_splitter import RecursiveCharacterTextSplitter
    from langchain.docstore.document import Document
    from opensearchpy import OpenSearch, RequestsHttpConnection
    from langchain.embeddings import HuggingFaceEmbeddings
    from typing import List, Tuple
    import json
    from langchain.document_loaders import (
        CSVLoader,
        EverNoteLoader,
        PyMuPDFLoader,
        TextLoader,
        UnstructuredEmailLoader,
        UnstructuredEPubLoader,
        UnstructuredHTMLLoader,
        UnstructuredMarkdownLoader,
        UnstructuredODTLoader,
        UnstructuredPowerPointLoader,
        UnstructuredWordDocumentLoader,
    )

    logging.info("All imports ok ...")
except Exception as e:
    logging.error(f"Error Imports : {e} ")

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)

chunk_size = 200
chunk_overlap = 50

# Map file extensions to document loaders and their arguments
LOADER_MAPPING = {
    ".csv": (CSVLoader, {}),
    ".doc": (UnstructuredWordDocumentLoader, {}),
    ".docx": (UnstructuredWordDocumentLoader, {}),
    ".enex": (EverNoteLoader, {}),
    ".epub": (UnstructuredEPubLoader, {}),
    ".html": (UnstructuredHTMLLoader, {}),
    ".md": (UnstructuredMarkdownLoader, {}),
    ".odt": (UnstructuredODTLoader, {}),
    ".pdf": (PyMuPDFLoader, {}),
    ".ppt": (UnstructuredPowerPointLoader, {}),
    ".pptx": (UnstructuredPowerPointLoader, {}),
    ".txt": (TextLoader, {"encoding": "utf8"}),
}


def get_awsCredentials():
    """
    Retrieve aws credentials
    """
    access_id = os.environ.get('ACCESS_ID')
    access_key = os.environ.get('ACCESS_KEY')
    return access_id, access_key


def get_secret():
    """
    Retrieve opensearch credentials from secrets manager
    """
    secret_name = "opensearch-secrets"
    region_name = os.environ.get('AWS_REGION')

    # Create a Secrets Manager client
    session = boto3.session.Session()
    client = session.client(
        service_name='secretsmanager',
        region_name=region_name
    )

    try:
        get_secret_value_response = client.get_secret_value(
            SecretId=secret_name
        )
    except ClientError as e:
        raise e

    # Decrypts secret using the associated KMS key.
    secret = get_secret_value_response['SecretString']
    return secret


def get_param():
    """
     Retrieve parameters required for OpenSearch
     """
    logging.info('Getting parameters for OpenSearch...')
    credentials = json.loads(get_secret())
    opensearch_username = credentials['MASTER_USERNAME']
    opensearch_password = credentials['MASTER_PASSWORD']
    opensearch_domain_endpoint = credentials['OPENSEARCH_DOMAIN_ENDPOINT']
    http_auth = (opensearch_username, opensearch_password)
    logging.info('Parameters successfully retrieved')
    return http_auth, opensearch_domain_endpoint


def load_single_document(file_path: str) -> List[Document]:
    """
    Maps document type to it's loading function and loads it
    Arguments:
        file_path: file path of the document
    """
    ext = "." + file_path.rsplit(".", 1)[-1]
    if ext in LOADER_MAPPING:
        loader_class, loader_args = LOADER_MAPPING[ext]
        loader = loader_class(file_path, **loader_args)
        return loader.load()
    raise ValueError(f"Unsupported file extension '{ext}'")


def load_documents(source_dir: str, ignored_files: List[str] = []) -> List[Document]:
    """
    Loads all documents from the source documents directory, ignoring specified files
    Arguments:
        source_dir: directory where the documents are located
        ignored_files: documents to ignore
    """
    all_files = []
    for ext in LOADER_MAPPING:
        all_files.extend(
            glob.glob(os.path.join(source_dir, f"**/*{ext}"), recursive=True)
        )
    filtered_files = [file_path for file_path in all_files if file_path not in ignored_files]
    with Pool(processes=os.cpu_count()) as pool:
        results = []
        with tqdm(total=len(filtered_files), desc='Loading new documents', ncols=80) as pbar:
            for i, docs in enumerate(pool.imap_unordered(load_single_document, filtered_files)):
                results.extend(docs)
                pbar.update()
    return results


def process_documents(source_directory, ignored_files: List[str] = []) -> List[Document]:
    """
    Load documents and split in chunks
    Arguments:
        source_directory: directory where the documents are located
        ignored_files: documents to ignore
    """
    logging.info('Processing documents')
    if len(os.listdir(source_directory)) == 0:
        logging.info("Directory is empty")
        exit(0)
    logging.info(f"Loading documents from {source_directory}")
    documents = load_documents(source_directory, ignored_files)
    if not documents:
        logging.info("No new documents to load")
        exit(0)
    logging.info(f"Loaded {len(documents)} new documents from {source_directory}")
    text_splitter = RecursiveCharacterTextSplitter(chunk_size=chunk_size, chunk_overlap=chunk_overlap)
    texts = text_splitter.split_documents(documents)
    logging.info(f"Split into {len(texts)} chunks of text (max. {chunk_size} tokens each)")
    return texts


def opensearch_exists(index_name: str, host: str, http_auth: Tuple[str, str]):
    """
    Check if documents already exist in opensearch
    Arguments:
        index_name: name of the index in opensearch
        host: opensearch endpoint
        http_auth : authentication credentials for aws opensearch
    """
    logging.info(f'Checking if documents already exist in index {index_name}....')
    aos_client = OpenSearch(
        hosts='https://' + host,
        http_auth=http_auth,
        use_ssl=True,
        verify_certs=True,
        connection_class=RequestsHttpConnection
    )
    exists = aos_client.indices.exists(index_name)
    return exists


def download_s3_folder(bucket_name, s3_folder, local_dir=None):
    """
    Download the contents of a folder directory
    Arguments:
        bucket_name: the name of the s3 bucket
        s3_folder: the folder path in the s3 bucket
        local_dir: a relative or absolute directory path in the local file system
    """
    logging.info(f'Downloading documents from S3 bucket: {bucket_name}, folder: {s3_folder}....')
    access_id, access_key = get_awsCredentials()
    try:
        s3 = boto3.resource('s3',
                            aws_access_key_id=access_id,
                            aws_secret_access_key=access_key)
        bucket = s3.Bucket(bucket_name)
        for obj in bucket.objects.filter(Prefix=s3_folder):
            target = obj.key if local_dir is None \
                else os.path.join(local_dir, os.path.relpath(obj.key, s3_folder))
            if not os.path.exists(os.path.dirname(target)):
                os.makedirs(os.path.dirname(target))
            if obj.key[-1] == '/':
                continue
            bucket.download_file(obj.key, target)
        return local_dir
    except Exception as e:
        return f'An error occurred while downloading S3 folder: {str(e)}'


def delete_folder_contents(folder_path):
    """
    Deletes the contents of the specified folder.
    Arguments:
        folder_path -- The path to the folder whose contents will be deleted.
    """
    logging.info(f'Deleting contents of {folder_path}')
    logging.info(os.listdir(folder_path))
    try:
        for filename in os.listdir(folder_path):
            file_path = os.path.join(folder_path, filename)
            if os.path.isfile(file_path):
                os.remove(file_path)
            else:
                shutil.rmtree(file_path)
                logging.info(os.listdir(folder_path))
        logging.info('Source Documents deleted successfully')
    except Exception as e:
        return f'An error occurred while deleting the contents of the folder: {str(e)}'


def get_embeddings():
    """
    Retrieves all-MiniLM-L6-v2 embeddings model from Hugging Face
    """
    logging.info('Getting embeddings')
    try:
        embeddings_model_name = os.environ.get('EMBEDDINGS_MODEL_NAME')
        embeddings = HuggingFaceEmbeddings(model_name=embeddings_model_name)
        logging.info('Embeddings retrieval successful')
        return embeddings
    except Exception as e:
        logging.error(f'Error getting embeddings: {e}')
        return None
