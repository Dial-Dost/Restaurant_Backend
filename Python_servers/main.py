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
from db import get_all_feedback, shutdown_db, get_valet_state_from_db, update_valet_state_from_db
from fastapi import FastAPI
from questions import generate_questions
from apscheduler.schedulers.background import BackgroundScheduler  # installed directly using pip, for some reason uv cannot install it
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
    scheduler.shutdown() # wait for any running jobs to finish before shutting down the scheduler
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
        return {"feedback": feedback[cat][ques_idx]['question']}
    else:
        exception(f"Invalid category requested: {category}")
        return {"error": "Invalid category"}
    
@app.get("/get_follow_up_question/{category}/{rate}")
async def get_follow_up_question(category: str, rate: int):
    info(f"Received request for follow-up question for category {category} with rate {rate}")
    random.seed(time.time())  # Ensure different random selection each time
    ques_idx = random.randint(0, tot_ques_each_cat - 1)
    ques = feedback["follow_up_questions"][ques_idx]['question']
    ques = ques.replace("<service>", category)
    ques = ques.replace("<rate>", str(rate))
    info(f"Selected follow-up question: {ques}")
    return {"feedback": ques}

@app.get("/get_valet_state/{number_plate}")
async def get_valet_state(number_plate: str):
    return {"valet_state": get_valet_state_from_db(number_plate)}


@app.post("/update_valet_state/{number_plate}/{state}")
async def update_valet_state(number_plate: str, state: int):
    if 1 <= state <= 6:
        return update_valet_state_from_db(number_plate, state)
    else:
        exception(f"Invalid valet state update requested: {state}")
        return {"error": "Invalid valet state"}

def main():
    uvicorn.run(app, host="127.0.0.1", port=int(os.getenv("PY_SERVER_PORT", 8000)))

if __name__ == "__main__":
    main()
