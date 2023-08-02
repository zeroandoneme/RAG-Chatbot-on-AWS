import logging

from langchain.schema import HumanMessage, AIMessage

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)

try:
    import os
    import json
    from flask import Flask, jsonify, request
    # from langchain.chains import RetrievalQA
    from langchain.memory import ConversationBufferMemory
    from langchain.prompts import PromptTemplate
    from langchain.chains import LLMChain, StuffDocumentsChain
    from langchain.chains.question_answering import load_qa_chain
    from langchain.chains import ConversationalRetrievalChain
    from prompts import CONDENSE_QUESTION_PROMPT as QUESTION_PROMPT, longchat_prompt_template
    from langchain.callbacks.streaming_stdout import StreamingStdOutCallbackHandler
    from langchain.chains.llm import LLMChain
    from langchain.chains.qa_with_sources import load_qa_with_sources_chain
    from utils import (
        load_model,
        init_opensearch,
        get_model_param,
        get_opensearch_param,
        get_embeddings,
    )

    logging.info("All imports ok ...")
except Exception as e:
    logging.error(f"Error Imports : {e} ")

AWS_ACCESS_KEY_ID = os.environ.get('ACCESS_KEY_ID')
AWS_SECRET_ACCESS_KEY = os.environ.get('SECRET_ACCESS_KEY')
# os.environ["LANGCHAIN_WANDB_TRACING"] = "true"

app = Flask(__name__)


def custom_message_serializer(message):
    if isinstance(message, HumanMessage):
        return {'type': 'HumanMessage', 'content': message.content, 'additional_kwargs': message.additional_kwargs,
                'example': message.example}
    elif isinstance(message, AIMessage):
        return {'type': 'AIMessage', 'content': message.content, 'additional_kwargs': message.additional_kwargs,
                'example': message.example}
    raise TypeError(f"Object of type {type(message).__name__} is not JSON serializable")


@app.route('/invocations', methods=['POST'])
def get_answer():
    logging.info('Answer endpoint invoked')

    # retrieving parameters required
    logging.info('Retrieving opensearch parameters')
    auth, opensearch_endpoint = get_opensearch_param()

    # Getting the required input
    data = request.get_json()
    index = data.get('index')
    query = data.get('prompt')

    if not index or not query:
        return jsonify({'error': 'Invalid request. "index" and "prompt" are required parameters.'}), 400

    docsearch = init_opensearch(index, embeddings, opensearch_endpoint, auth)
    retriever = docsearch.as_retriever()

    if not docsearch:
        return jsonify({'error': 'Failed to initialize OpenSearch.'}), 500

    # Getting the reply from the model
    if request.method == 'POST':
        if query is not None and query != "":
            logging.info(f"query {query}")

            if llm is None:
                logging.error('Model not found')
                return jsonify({'error': 'Model not downloaded'}), 400

            callbacks = [StreamingStdOutCallbackHandler()]

            qa = ConversationalRetrievalChain.from_llm(
                llm=llm,
                retriever=retriever,
                # callbacks=callbacks,
                memory=memory,
                verbose=False,
                rephrase_question=False,
                combine_docs_chain_kwargs={"prompt": longchat_prompt_template},
                return_source_documents=True,
                # condense_question_prompt=QUESTION_PROMPT
            )

            res = qa(query)
            print('\nThis is the result')
            print(res)

            logging.info(f"retrieval result {res}")

            answer = res['answer']
            docs = res['source_documents']
            history = res['chat_history']

            source_data = []
            for document in docs:
                source_data.append({"name": document.metadata["source"]})

            history_data = [custom_message_serializer(message) for message in history]

            response = {
                'query': query,
                'answer': answer,
                'source': source_data,
                'index': index,
                'chat_history': history_data
            }

            logging.info(f"get answer response {response}")

            return jsonify(response), 200
        else:
            return jsonify({'error': 'Empty Query'}), 400
    else:
        return jsonify({'error': 'Invalid request or Content-Type'}), 400


@app.route('/ping', methods=['GET'])
def ping():
    return "pinged", 200


@app.route('/', methods=['GET'])
def health_check():
    return "pinged", 200


if __name__ == "__main__":
    # Retrieving model parameters and loading llm model
    path, n_ctx = get_model_param()
    llm = load_model(path, n_ctx)

    # Loading embeddings model from huggingface
    embeddings = get_embeddings()

    target_source_chunks = int(os.environ.get('TARGET_SOURCE_CHUNKS', 4))

    # Initializing the memory
    # chat_history = []
    memory = ConversationBufferMemory(memory_key="chat_history", return_messages=True, output_key='answer')

    app.run(
        host='0.0.0.0',
        port=8080
    )
