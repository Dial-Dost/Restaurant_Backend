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


# def test_get_valet_state():
#     number_plate = "TEST123"
#     response = requests.get(f"http://localhost:8000/get_valet_state/{number_plate}")
#     assert response.status_code == 200
#     data = response.json()
#     print(data)
#     assert "valet_state" in data

# def create_valet_record(number_plate: str, state: int):
#     response = requests.post(f"http://localhost:8000/update_valet_state/{number_plate}/{state}")
#     assert response.status_code == 200
#     data = response.json()
#     print(data)
#     assert "message" in data

# def test_update_valet_state():
#     number_plate = "TEST123"
#     # First, create a new valet record with state 1 (Car Parked)
#     create_valet_record(number_plate, 1)

#     # Now, update the valet state to 6 (Car Picked Up)
#     response = requests.post(f"http://localhost:8000/update_valet_state/{number_plate}/6")
#     assert response.status_code == 200
#     data = response.json()
#     print(data)
#     assert "message" in data


def create_valet_record(
    number_plate: str = "TEST123", restaurant_id: str = "TEST_RESTAURANT"
) -> str:
    response = requests.post(
        f"http://localhost:8000/create_valet_record/{number_plate}/{restaurant_id}"
    )
    assert response.status_code == 200
    data = response.json()
    print(data)
    assert "booking_id" in data
    return data.get("booking_id")


def test_get_valet_info(booking_id: str):
    response = requests.get(f"http://localhost:8000/get_valet_info/{booking_id}")
    assert response.status_code == 200
    data = response.json()
    print(data)
    assert "booking_id" in data


def test_update_valet_state(booking_id: str):
    # Now, update the valet state to 6 (Car Picked Up)
    response = requests.post(f"http://localhost:8000/update_valet_state/{booking_id}/6")
    assert response.status_code == 200
    data = response.json()
    print(data)
    assert "booking_id" in data


def test_update_valet_bay(booking_id: str):
    # Now, update the valet bay to "Bay A"
    response = requests.post(
        f"http://localhost:8000/update_valet_bay/{booking_id}/Bay A"
    )
    assert response.status_code == 200
    data = response.json()
    print(data)
    assert "booking_id" in data


def test_add_and_get_bays(restaurant_id: str = "TEST_RESTAURANT"):
    # Add a bay
    response = requests.post(
        f"http://localhost:8000/add_bay/{restaurant_id}",
        json={"Bay_name": "Main", "total_capacity": 5},
    )
    assert response.status_code == 200
    data = response.json()
    print(data)
    assert "Bay_id" in data

    # Get bays
    response2 = requests.get(f"http://localhost:8000/get_bays/{restaurant_id}")
    assert response2.status_code == 200
    list_data = response2.json()
    print(list_data)
    assert isinstance(list_data, list)


test_root()
test_get_feedback()
test_get_follow_up_question()
booking_id = create_valet_record("TEST123", "TEST_RESTAURANT")
test_update_valet_state(booking_id)
test_update_valet_bay(booking_id)
test_get_valet_info(booking_id)
test_add_and_get_bays("TEST_RESTAURANT")
