"""
Category with no.
1 - initial_greeting
2 - waiter_serving
3 - food
4 - ambience
5 - restroom
6 - valet_parking
7 - follow_up_questions

Valet-state with no.
1 - key recieved
2 - parked
3 - return request initiated
4 - return request accepted
5 - return request completed
6 - car returned
"""

import uvicorn
import random
import time
import os
from util.logger import info, exception
from db import (
    get_all_feedback,
    shutdown_db,
    get_valet_info_from_db,
    update_valet_state_from_db,
    update_valet_bay_from_db,
    create_valet_record_in_db,
    get_all_bays_from_db,
    add_bay_in_db,
    get_all_valet_records_from_db,
)
from fastapi import FastAPI
from questions import generate_questions
from apscheduler.schedulers.background import (
    BackgroundScheduler,
)  # installed directly using pip, for some reason uv cannot install it
from contextlib import asynccontextmanager

categories = [
    "initial_greeting",
    "waiter_serving",
    "food",
    "ambience",
    "restroom",
    "valet_parking",
    "follow_up_questions",
]
tot_ques_each_cat = 20
feedback = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    global feedback, tot_ques_each_cat
    # Startup logic
    # every day at 2:00 AM, generate questions and save to database
    scheduler = BackgroundScheduler()
    scheduler.add_job(generate_questions, "cron", hour=2, minute=00)
    scheduler.start()

    feedback = get_all_feedback()
    info("Fetched all feedback from the database")
    tot_ques_each_cat = len(feedback["initial_greeting"])
    info(f"Total questions per category: {tot_ques_each_cat}")
    info(f"Categories available: {feedback.keys()}")
    yield

    # Shutdown logic e.g., close DB connections, stop schedulers, flush logs
    scheduler.shutdown()  # wait for any running jobs to finish before shutting down the scheduler
    shutdown_db()


app = FastAPI(lifespan=lifespan)


@app.get("/")
async def root():
    return {"message": "Hi from the Restaurant Feedback System!"}


@app.get("/get_main_feedback_question/{category}")
async def get_feedback(category: int):
    info(f"Received request for category {category}")
    if 1 <= category <= len(categories) - 1:
        random.seed(time.time())  # Ensure different random selection each time
        cat = categories[category - 1]
        ques_idx = random.randint(0, tot_ques_each_cat - 1)
        info(f"Selected question for category {category}: {feedback[cat][ques_idx]}")
        return {"feedback": feedback[cat][ques_idx]["question"]}
    else:
        exception(f"Invalid category requested: {category}")
        return {"error": "Invalid category"}


@app.get("/get_follow_up_question/{category}/{rate}")
async def get_follow_up_question(category: str, rate: int):
    info(
        f"Received request for follow-up question for category {category} with rate {rate}"
    )
    random.seed(time.time())  # Ensure different random selection each time
    ques_idx = random.randint(0, tot_ques_each_cat - 1)
    ques = feedback["follow_up_questions"][ques_idx]["question"]
    ques = ques.replace("<service>", category)
    ques = ques.replace("<rate>", str(rate))
    info(f"Selected follow-up question: {ques}")
    return {"feedback": ques}


# @app.get("/get_valet_state/{number_plate}")
# async def get_valet_state(number_plate: str):
#     return {"valet_state": get_valet_state_from_db(number_plate)}


# @app.post("/update_valet_state/{number_plate}/{state}")
# async def update_valet_state(number_plate: str, state: int):
#     if 1 <= state <= 6:
#         return update_valet_state_from_db(number_plate, state)
#     else:
#         exception(f"Invalid valet state update requested: {state}")
#         return {"error": "Invalid valet state"}


@app.get("/get_valet_info/{booking_id}")
async def get_valet_info(booking_id: str):
    return get_valet_info_from_db(booking_id)


@app.post("/update_valet_state/{booking_id}/{state}")
async def update_valet_state(booking_id: str, state: int):
    if 1 <= state <= 6:
        return update_valet_state_from_db(booking_id, state)
    else:
        exception(f"Invalid valet state update requested: {state}")
        return {"error": "Invalid valet state"}


@app.post("/update_valet_bay/{booking_id}/{bay_id}")
async def update_valet_bay(booking_id: str, bay_id: str):
    if not bay_id or bay_id.strip() == "":
        exception(f"Invalid valet bay id update requested: '{bay_id}'")
        return {"error": "Invalid valet bay id"}
    return update_valet_bay_from_db(booking_id, bay_id)


@app.post("/create_valet_record/{number_plate}/{restaurant_id}")
async def create_valet_record(number_plate: str, restaurant_id: str):
    if not number_plate or number_plate.strip() == "":
        exception(f"Invalid number plate for valet record creation: '{number_plate}'")
        return {"error": "Invalid number plate"}
    if not restaurant_id or restaurant_id.strip() == "":
        exception(f"Invalid restaurant ID for valet record creation: '{restaurant_id}'")
        return {"error": "Invalid restaurant ID"}
    return create_valet_record_in_db(number_plate, restaurant_id)


@app.get("/get_all_valet_records/{restaurant_id}")
async def get_all_valet_records(restaurant_id: str):
    if not restaurant_id or restaurant_id.strip() == "":
        exception(
            f"Invalid restaurant ID for fetching valet records: '{restaurant_id}'"
        )
        return {"error": "Invalid restaurant ID"}
    return get_all_valet_records_from_db(restaurant_id)


@app.get("/get_bays/{restaurant_id}")
async def get_bays(restaurant_id: str):
    if not restaurant_id or restaurant_id.strip() == "":
        exception(f"Invalid restaurant ID for fetching bays: '{restaurant_id}'")
        return {"error": "Invalid restaurant ID"}
    return get_all_bays_from_db(restaurant_id)


@app.post("/add_bay/{restaurant_id}")
async def add_bay(restaurant_id: str, bay: dict):
    # bay expected to be JSON body like {"Bay_name": "Main", "total_capacity": 10}
    bay_name = bay.get("Bay_name") if isinstance(bay, dict) else None
    total_capacity = bay.get("total_capacity") if isinstance(bay, dict) else None
    if not bay_name or not isinstance(bay_name, str) or bay_name.strip() == "":
        exception(f"Invalid bay name for adding Bay: '{bay_name}'")
        return {"error": "Invalid bay name"}

    try:
        total = int(total_capacity) if total_capacity is not None else 0
    except Exception:
        total = 0

    return add_bay_in_db(restaurant_id, bay_name.strip(), total)


def main():
    uvicorn.run(app, host="127.0.0.1", port=int(os.getenv("PY_SERVER_PORT", 8000)))


if __name__ == "__main__":
    main()
