"""Managed loopback ASR transport. Models remain offline and explicitly provisioned."""
from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1',
                  HF_HUB_DISABLE_IMPLICIT_TOKEN='1')

from serve import build_server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-directory', required=True, type=Path)
    args = parser.parse_args()
    if not args.data_directory.is_absolute():
        parser.error('data directory must be absolute')
    server, jobs = build_server(args.data_directory, 0)

    def parent_closed():
        # A killed Node process closes its stdin pipe. Do not orphan this worker
        # or its supervised transcriber; ImportJobs.close settles owned processes.
        sys.stdin.buffer.read()
        server.shutdown()

    threading.Thread(target=parent_closed, name='coconut-parent', daemon=True).start()

    def stop(_signum, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print(json.dumps({'protocolVersion': 1, 'port': server.server_port}), flush=True)
    try:
        server.serve_forever(poll_interval=0.1)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        jobs.close()


if __name__ == '__main__':
    main()
