import os
import time
import json
from typing import List
from pydantic import BaseModel, Field, field_validator

from google import genai
from google.genai import types
from dotenv import load_dotenv

from util.logger import info, warning, error


# =====================================================================
# 1. Define Pydantic Models for Structured Output
# =====================================================================
load_dotenv()  # Load environment variables from .env file


class FeedbackQuestions(BaseModel):
    initial_greeting: List[str] = Field(
        description="20 distinct feedback questions regarding the initial greeting by staff.",
        min_length=20,
        max_length=20,
    )
    waiter_serving: List[str] = Field(
        description="20 distinct feedback questions regarding the waiter's service.",
        min_length=20,
        max_length=20,
    )
    food: List[str] = Field(
        description="20 distinct feedback questions regarding the food quality, taste, and presentation.",
        min_length=20,
        max_length=20,
    )
    ambience: List[str] = Field(
        description="20 distinct feedback questions regarding the restaurant's ambience and atmosphere.",
        min_length=20,
        max_length=20,
    )
    restroom: List[str] = Field(
        description="20 distinct feedback questions regarding the cleanliness and state of the restrooms.",
        min_length=20,
        max_length=20,
    )
    valet_parking: List[str] = Field(
        description="20 distinct feedback questions regarding the valet parking service.",
        min_length=20,
        max_length=20,
    )
    follow_up_questions: List[str] = Field(
        description="20 follow-up questions asking for more description based on a previous rating. MUST contain exact strings <rate> and <service>.",
        min_length=20,
        max_length=20,
    )

    # Pydantic rule/validator to ensure the exact placeholders are present
    @field_validator("follow_up_questions")
    @classmethod
    def check_placeholders(cls, questions: List[str]) -> List[str]:
        for i, q in enumerate(questions):
            if "<rate>" not in q or "<service>" not in q:
                raise ValueError(
                    f"Question {i} missing <rate> or <service> placeholder: {q}"
                )
        return questions


# =====================================================================
# 2. Exponential Retry Logic (For Generation and Token Counting)
# =====================================================================


def generate_with_retry(
    client: genai.Client,
    model: str,
    prompt: str,
    schema: type[BaseModel],
    max_retries: int = 5,
):
    """Calls the Gemini API to generate content with exponential backoff."""
    base_delay = 2
    for attempt in range(max_retries):
        try:
            info(f"Generating questions (Attempt {attempt + 1})...")
            response = client.models.generate_content(
                model=model,
                contents=prompt,
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=schema,
                    temperature=0.7,
                ),
            )
            if not response.text:
                continue
            validated_data = schema.model_validate_json(response.text)
            return FeedbackQuestions(**validated_data.model_dump())
        except Exception as e:
            if attempt == max_retries - 1:
                raise Exception(
                    f"Failed to generate after {max_retries} attempts. Last error: {e}"
                )
            sleep_time = base_delay * (2**attempt)
            warning(f"Generation failed, retrying in {sleep_time}s...")
            time.sleep(sleep_time)


def count_tokens_with_retry(
    client: genai.Client, model: str, text: str, max_retries: int = 5
) -> int:
    """Calls the Gemini API to count tokens with exponential backoff to handle rate limits."""
    base_delay = 1
    for attempt in range(max_retries):
        try:
            response = client.models.count_tokens(model=model, contents=text)
            if not response.total_tokens:
                continue
            return response.total_tokens
        except Exception as e:
            if attempt == max_retries - 1:
                error(f"Failed to count tokens for text: '{text[:30]}...'. Error: {e}")
                return 0  # Fallback if we completely fail to count
            sleep_time = base_delay * (2**attempt)
            time.sleep(sleep_time)
    return 0  # Final fallback


# =====================================================================
# 3. Main Execution
# =====================================================================


def generate_questions():
    # Fetch Environment Variables
    api_key = os.environ.get("GEMINI_API_KEY")

    # SQLite connection string format: sqlite:///filename.db
    # This creates a file named 'restaurant_feedback.db' in your current working directory
    # db_url = os.environ.get("DATABASE_URL", "sqlite:///db/restaurant_feedback.db")

    if not api_key:
        error(
            json.dumps(
                {"error": "Please set the GEMINI_API_KEY environment variable."},
                indent=4,
            )
        )
        return

    client = genai.Client(api_key=api_key)
    model_name = "gemini-2.5-flash-lite"

    prompt = """
    You are an expert hospitality consultant. Generate a highly detailed JSON object containing exactly 20 distinct feedback questions for each of the following restaurant categories:
    - initial_greeting
    - waiter_serving
    - food
    - ambience
    - restroom
    - valet_parking
    
    Additionally, create a list of exactly 20 "follow_up_questions". 
    CRITICAL RULE: Every single follow-up question MUST include the exact literal strings "<rate>" and "<service>".
    Example of a valid follow-up: "You rated the <service> as <rate>. Could you please provide more details on why you gave this rating?"
    
    Ensure strict compliance with the required array sizes (exactly 20 per list). Do not include markdown formatting, just the JSON.
    """

    try:
        from db import save_to_feedback_database

        # 1. Generate the payload
        feedback_data = generate_with_retry(
            client=client,
            model=model_name,
            prompt=prompt,
            schema=FeedbackQuestions,
            max_retries=5,
        )

        if not feedback_data:
            raise ValueError("Failed to generate valid feedback questions.")

        # 2. Save results to Database via SQLAlchemy
        save_to_feedback_database(client, model_name, feedback_data)

        # 3. Output strictly formatted JSON string to standard output
        json_output = feedback_data.model_dump_json(indent=4)
        info(json_output)

    except Exception as e:
        error(json.dumps({"error": str(e)}, indent=4))


if __name__ == "__main__":
    generate_questions()
