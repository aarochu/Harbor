import os

from fastapi import FastAPI
from sqlalchemy import create_engine, text

app = FastAPI(title="harbor-demo-clean")

engine = create_engine(os.environ["DATABASE_URL"], pool_pre_ping=True)


@app.get("/health")
def health():
    with engine.connect() as connection:
        connection.execute(text("SELECT 1"))
    return {"status": "ok"}


@app.get("/")
def index():
    return {"service": "harbor-demo-clean"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))
