import requests

def test_root():
    response = requests.get("http://localhost:8000/")
    assert response.status_code == 200
    data = response.json()
    print(data)
    assert "message" in data
    assert data["message"] == "Hi from the Restaurant Feedback System!"

def test_get_feedback():
    response = requests.get("http://localhost:8000/get_main_feedback_question/1")
    assert response.status_code == 200
    data = response.json()
    print(data)
    assert "feedback" in data
    # assert "question" in data["feedback"]

def test_get_follow_up_question():
    response = requests.get("http://localhost:8000/get_follow_up_question/food/4")
    assert response.status_code == 200
    data = response.json()
    print(data)
    assert "feedback" in data
    assert "<service>" not in data["feedback"]
    assert "<rate>" not in data["feedback"]

def test_get_valet_state():
    number_plate = "TEST123"
    response = requests.get(f"http://localhost:8000/get_valet_state/{number_plate}")
    assert response.status_code == 200
    data = response.json()
    print(data)
    assert "valet_state" in data

def create_valet_record(number_plate: str, state: int):
    response = requests.post(f"http://localhost:8000/update_valet_state/{number_plate}/{state}")
    assert response.status_code == 200
    data = response.json()
    print(data)
    assert "message" in data

def test_update_valet_state():
    number_plate = "TEST123"
    # First, create a new valet record with state 1 (Car Parked)
    create_valet_record(number_plate, 1)

    # Now, update the valet state to 6 (Car Picked Up)
    response = requests.post(f"http://localhost:8000/update_valet_state/{number_plate}/6")
    assert response.status_code == 200
    data = response.json()
    print(data)
    assert "message" in data

test_root()
test_get_feedback()
test_get_follow_up_question()
test_update_valet_state()
test_get_valet_state()