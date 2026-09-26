"""A service lets at most as many requests reach its database at once as
it has connections. Past that, sync endpoints held the threadpool waiting
for a connection while the requests holding one waited for a thread to
serialize their answer -- a 30 s jam and "The server had a problem" while
scrolling fast in the viewer."""
import asyncio

import pytest
from shared_auth.request_limit import RequestLimitMiddleware


def _app(state, delay=0.05):
    async def app(scope, receive, send):
        state["now"] += 1
        state["peak"] = max(state["peak"], state["now"])
        await asyncio.sleep(delay)
        state["now"] -= 1
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    return app


async def _call(app, path):
    sent = []

    async def receive():
        return {"type": "http.request"}

    async def send(msg):
        sent.append(msg)

    await app({"type": "http", "path": path, "method": "GET", "headers": []}, receive, send)
    return sent


@pytest.mark.parametrize("limit", [1, 3])
def test_no_more_than_the_limit_run_at_once(limit):
    state = {"now": 0, "peak": 0}
    app = RequestLimitMiddleware(_app(state), limit=limit, exempt=("/health",))

    async def main():
        await asyncio.gather(*(_call(app, "/data/x") for _ in range(10)))

    asyncio.run(main())
    assert state["peak"] == limit


def test_exempt_paths_and_non_http_pass_straight_through():
    state = {"now": 0, "peak": 0}
    app = RequestLimitMiddleware(_app(state), limit=1, exempt=("/data/objects", "/health"))

    async def main():
        await asyncio.gather(*(_call(app, "/data/objects") for _ in range(5)))

    asyncio.run(main())
    assert state["peak"] == 5
