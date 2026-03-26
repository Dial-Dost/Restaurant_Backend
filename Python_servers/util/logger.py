import logging
import os
from datetime import datetime

# Ensure logs directory exists at repository root
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
LOG_DIR = os.path.join(ROOT, "logs")
os.makedirs(LOG_DIR, exist_ok=True)

# Log filename with format dd-mm-yyyy-hh-mm-ss.log
timestamp = datetime.now().strftime("%d-%m-%Y-%H-%M-%S")
log_path = os.path.join(LOG_DIR, f"{timestamp}.log")

# Create logger
logger = logging.getLogger("restaurant_feedback")
logger.setLevel(logging.INFO)

# Formatter with readable datetime and source file
# Include filename and line number to show which Python file emitted the log
formatter = logging.Formatter(
    "%(asctime)s - %(levelname)s - %(filename)s:%(lineno)d - %(message)s",
    datefmt="%d-%m-%Y %H:%M:%S",
)

# Stream handler (console)
sh = logging.StreamHandler()
sh.setLevel(logging.INFO)
sh.setFormatter(formatter)
logger.addHandler(sh)

# File handler
fh = logging.FileHandler(log_path, encoding="utf-8")
fh.setLevel(logging.INFO)
fh.setFormatter(formatter)
logger.addHandler(fh)


def info(msg: str, *args, **kwargs) -> None:
    if "stacklevel" not in kwargs:
        kwargs["stacklevel"] = 2
    logger.info(msg, *args, **kwargs)


def debug(msg: str, *args, **kwargs) -> None:
    if "stacklevel" not in kwargs:
        kwargs["stacklevel"] = 2
    logger.debug(msg, *args, **kwargs)


def warning(msg: str, *args, **kwargs) -> None:
    if "stacklevel" not in kwargs:
        kwargs["stacklevel"] = 2
    logger.warning(msg, *args, **kwargs)


def error(msg: str, *args, **kwargs) -> None:
    if "stacklevel" not in kwargs:
        kwargs["stacklevel"] = 2
    logger.error(msg, *args, **kwargs)


def exception(msg: str, *args, **kwargs) -> None:
    if "stacklevel" not in kwargs:
        kwargs["stacklevel"] = 2
    logger.exception(msg, *args, **kwargs)
