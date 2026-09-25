"""With object storage down every call took 4-13 s before failing -- boto's
default connect timeout and retries. One quick retry, a short connect
timeout (observation from the exclusive window, see I-08)."""
from app import storage


def test_the_storage_client_fails_fast():
    config = storage._client.meta.config
    assert config.connect_timeout <= 3
    assert config.retries["total_max_attempts"] <= 2  # the call and one retry
