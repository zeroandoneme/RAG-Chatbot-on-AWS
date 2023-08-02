from langchain.prompts.prompt import PromptTemplate

longchat_template = """You are an assistant to students. Use the following information to answer the question at the 
end by understanding it and generating your own response. Answer the question based on the context provided while 
taking the history into consideration. If the question is just a greeting or goodbye such as "Hi", "Hello", 
"Thank you", "Bye" ignore the context and history. Ignore any information that is not relevant to the question. Do 
not ask questions.

History: 
{chat_history} 

Contexts:
{context} 

question: {question}

answer:"""

longchat_prompt_template = PromptTemplate(
    input_variables=["chat_history", "context", "question"], template=longchat_template
)


_template = """Given the following conversation and a follow up question, if relevant use only the most recent part 
of the conversation and rephrase the follow up question to be a standalone question ONLY IF ITS RELATED TO THE FOLLOW 
UP QUESTION.. Do not change the meaning behind the original question. If the follow up question is a greeting, 
or if the chat history is not relevant, reply with the follow up question as it is. 

Question: {question}

Chat History:
{chat_history}

Returned question:"""
CONDENSE_QUESTION_PROMPT = PromptTemplate.from_template(_template)


prompt_template = """Use the following pieces of chat_history and context to answer the question at the end. If the 
context is not relevant DO NOT USE IT. If you don't know the answer, just say that you don't know, don't try to make 
up an answer.

Chat History: {chat_history}

Context: {context}

Question: {question}
Helpful Answer:"""
QA_PROMPT = PromptTemplate(
    template=prompt_template, input_variables=["chat_history", "context", "question"]
)

human_template = """
    User Query: {query}

    Relevant Context: {context}
"""