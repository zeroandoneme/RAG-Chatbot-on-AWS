#!/usr/bin/env python3
try:
    import os
    import boto3
    from botocore.exceptions import ClientError
    import json
    import logging
    from dotenv import load_dotenv
    from langchain.callbacks.streaming_stdout import StreamingStdOutCallbackHandler
    from langchain.vectorstores import OpenSearchVectorSearch
    from langchain.llms import GPT4All, LlamaCpp, CTransformers
    from langchain.schema import HumanMessage, AIMessage
    from opensearchpy import RequestsHttpConnection
    from langchain.embeddings import HuggingFaceEmbeddings
    from langchain.callbacks.manager import CallbackManager

    logging.info("All imports ok ...")
except Exception as e:
    logging.error(f"Error Imports : {e} ")

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)


def get_model_param():
    """
    Retrieve parameters for the LLM model from environment variables
    """
    model_path = os.environ.get('MODEL_PATH')
    model_n_ctx = os.environ.get('MODEL_N_CTX')
    return model_path, model_n_ctx


def get_secret():
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


def get_opensearch_param():
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


def get_embeddings():
    """
    Retrieves all-MiniLM-L6-v2 embeddings model from Hugging Face
    """
    logging.info('Getting embeddings')
    try:
        embeddings_model_name = os.environ.get('EMBEDDINGS_MODEL_NAME')
        embeddings = HuggingFaceEmbeddings(
            model_name=embeddings_model_name,
        )
        logging.info('Embeddings retrieval successful')
        return embeddings
    except Exception as e:
        logging.error(f'Error getting embeddings: {e}')
        return None


def init_opensearch(index_name, embeddings, endpoint, auth):
    """
    Initiating OpenSearch

    Arguments:
    index_name -- name of the opensearch index
    embeddings -- all-MiniLM-L6-v2 embeddings
    endpoint -- opensearch endpoint
    auth -- credentials for aws opensearch
    """
    logging.info('Initializing OpenSearch')
    try:
        docsearch = OpenSearchVectorSearch(
            index_name=index_name,
            embedding_function=embeddings,
            opensearch_url='https://' + endpoint,
            http_auth=auth,
            use_ssl=True,
            verify_certs=True,
            connection_class=RequestsHttpConnection,
            is_aoss=False,
            engine="faiss",
        )
        logging.info('Initializing OpenSearch successful')
        logging.info(f"docsearch output {docsearch}")
        return docsearch
    except Exception as e:
        logging.error(f'Error initializing OpenSearch: {e}')


def load_model(model_path, model_n_ctx):
    """
    loading LLM

    Arguments:
    model_path -- path where the model is located
    model_n_ctx -- maximum token limit for the model
    """
    logging.info('Loading Model....')
    model_type = os.environ.get('MODEL_TYPE')
    if os.path.exists(model_path):
        callback_manager = CallbackManager([StreamingStdOutCallbackHandler()])
        callbacks = [StreamingStdOutCallbackHandler()]
        try:
            if model_type == 'gpt4all':
                # Loading model using GPT4ALL (for gpt4all models)
                llm = GPT4All(model=model_path, n_ctx=model_n_ctx, backend='gptj', callbacks=callbacks, verbose=False,
                              temp=0.7,
                              top_p=0.1, top_k=40, n_batch=128, repeat_penalty=1.18, repeat_last_n=64)
            elif model_type == 'llama':
                # Loading model using Llama.cpp (for llama models)
                llm = LlamaCpp(
                    model_path=model_path,
                    n_gpu_layers=100,
                    n_batch=100,
                    n_ctx=2048,
                    max_tokens=512,
                    streaming=True,
                    callback_manager=callback_manager,
                    temperature=0.7,
                    top_k=100,
                    repeat_penalty=1.15,
                )
            elif model_type == 'ctransformers':
                # Loading model using CTransformers (works with falcon)
                config = {'gpu_layers': 10, 'top_k': 40, 'top_p': 0.1, 'temperature': 1, 'stream': False,
                          'batch_size': 10}
                llm = CTransformers(
                    model=model_path,
                    model_type='falcon',
                    callbacks=[StreamingStdOutCallbackHandler()],
                    config=config
                )
            else:
                logging.error('Invalid model type')
                return None
            logging.info('Loading Model succeeded')
            return llm
        except Exception as e:
            raise Exception("Failed to load model") from e
    else:
        raise FileNotFoundError(f"Model path '{model_path}' does not exist.")
