FROM python:3.11

COPY requirements.txt ./
RUN pip3 install -r requirements.txt
COPY . ./

EXPOSE 8080

ENTRYPOINT ["python", "ingest.py"]