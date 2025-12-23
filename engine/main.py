# engine/main.py
# Houses the main logic for the system

import sys, json

def decompose_task(task_name):

    # Mock logic, hardcoded values
    mock_result = {
        "originalTask": task_name,
        "subtasks": [
            {
                "title": f"Research basics of {task_name}",
                "difficulty": "easy",
                "timeEstimate": 15
            },
            {
                "title": f"Draft initial outline for {task_name}",
                "difficulty": "medium",
                "timeEstimate": 30
            },
            {
                "title": f"Complete deep work session on {task_name}",
                "difficulty": "hard",
                "timeEstimate": 60
            }
        ]
    }
    return mock_result