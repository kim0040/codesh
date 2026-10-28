#!/usr/bin/env python3
"""Test transport: preserve argv and stdin while executing the actual Linux program."""
import json
import os
import sys

argv = sys.argv[1:]
if os.environ.get("GACHIPAD_WSL_ARGV_LOG"):
    with open(os.environ["GACHIPAD_WSL_ARGV_LOG"], "a", encoding="utf-8") as log:
        log.write(json.dumps(argv, ensure_ascii=False) + "\n")
if argv[:1] == ["--utf16"]:
    sys.stdout.buffer.write(("\ufeff" + argv[1]).encode("utf-16le"))
    sys.exit(0)
if argv[:1] == ["--pty"]:
    import errno
    import pty
    import select
    import subprocess
    import time

    master, slave = pty.openpty()
    child = subprocess.Popen(argv[1:], stdin=slave, stdout=slave, stderr=slave)
    os.close(slave)
    transcript = b""
    acknowledged = False
    deadline = time.monotonic() + 20
    try:
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.1)[0]:
                try:
                    data = os.read(master, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise
                if not data:
                    break
                transcript += data
                if b"LIVE-TTY" in transcript and not acknowledged:
                    # The child must display progress before it receives input.
                    if child.poll() is not None:
                        raise RuntimeError("progress was buffered until child exit")
                    os.write(master, b"continue\n")
                    acknowledged = True
            elif child.poll() is not None:
                break
        child.wait(timeout=1)
        sys.stdout.buffer.write(transcript)
        sys.exit(0 if acknowledged and child.returncode == 0 else 1)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
if argv[:1] == ["-d"]:
    del argv[:2]
if argv[:1] == ["--cd"]:
    os.chdir(argv[1])
    del argv[:2]
assert argv.pop(0) == "--exec", argv
if argv[:2] == ["wslpath", "-u"]:
    print(os.environ.get("GACHIPAD_TEST_SOURCE", argv[2]))
    sys.exit(0)
os.execvp(argv[0], argv)
