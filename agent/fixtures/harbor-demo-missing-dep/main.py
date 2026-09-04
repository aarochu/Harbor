import os

import httpx
from fastapi import FastAPI

app = FastAPI(title="harbor-demo-missing-dep")


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/upstream")
async def upstream():
    async with httpx.AsyncClient() as client:
        response = await client.get("https://example.com")
    return {"status_code": response.status_code}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))
