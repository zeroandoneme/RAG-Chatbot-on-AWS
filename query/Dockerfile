FROM python:3.11

COPY requirements.txt ./
RUN pip3 install -r requirements.txt
RUN CMAKE_ARGS="-DLLAMA_CUBLAS=on" FORCE_CMAKE=1 pip install llama-cpp-python
COPY . ./

EXPOSE 8080

ENTRYPOINT ["python", "answer.py"]