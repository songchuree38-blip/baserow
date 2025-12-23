import asyncio

from loguru import logger


class dummy_context:
    async def __aenter__(self):
        pass

    async def __aexit__(self, exc_type, exc, traceback):
        pass


class ConcurrencyLimiterASGI:
    """
    Helper wrapper on ASGI app to limit the number of requests handled
    at the same time.
    """

    def __init__(self, app, max_concurrency: int | None = None):
        self.app = app
        logger.info(f"Setting ASGI app concurrency to {max_concurrency}")
        self.semaphore = (
            asyncio.Semaphore(max_concurrency)
            if (isinstance(max_concurrency, int) and max_concurrency > 0)
            else dummy_context()
        )

    async def __call__(self, scope, receive, send):
        async with self.semaphore:
            await self.app(scope, receive, send)


def log_env_warnings():
    from django.conf import settings

    if not settings.BASEROW_PUBLIC_URL:
        if settings.BASEROW_PUBLIC_URL == "http://localhost":
            logger.warning(
                "Baserow is configured to use a BASEROW_PUBLIC_URL of "
                "http://localhost. If you attempt to access Baserow on any other hostname "
                "requests to the backend will fail as they will be from an unknown host. "
                "Please set BASEROW_PUBLIC_URL if you will be accessing Baserow "
                "from any other URL than http://localhost."
            )
    else:
        if settings.PUBLIC_BACKEND_URL == "http://localhost:8000":
            logger.warning(
                "Baserow is configured to use a PUBLIC_BACKEND_URL of "
                "http://localhost:8000. If you attempt to access Baserow on any other "
                "hostname requests to the backend will fail as they will be from an "
                "unknown host. "
                "Please ensure you set PUBLIC_BACKEND_URL if you will be accessing "
                "Baserow from any other URL than http://localhost."
            )
        if settings.PUBLIC_WEB_FRONTEND_URL == "http://localhost:3000":
            logger.warning(
                "Baserow is configured to use a default PUBLIC_WEB_FRONTEND_URL "
                "of http://localhost:3000. Emails sent by Baserow will use links pointing "
                "to http://localhost:3000 when telling users how to access your server. If "
                "this is incorrect please ensure you have set PUBLIC_WEB_FRONTEND_URL to "
                "the URL where users can access your Baserow server."
            )
