FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir fastapi==0.115.* uvicorn==0.32.* docker==7.1.* pydantic==2.*

COPY app.py .

# This service itself is NOT sandboxed — it needs the Docker socket to
# spawn the sandboxed executor containers. Keep it minimal, keep it
# admin-request-only (backend enforces requireAdmin before ever calling
# this service), and never expose its port outside the `visiyon` network.
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
