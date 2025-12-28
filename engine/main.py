# engine/main.py
# Houses the main logic for the system

import sys, json

def decompose_task(task_name):

    # Mock logic, hardcoded values
    mock_result = {
        "originalTask": task_name,
        "subtasks": [
            {   
                "id": "1",
                "title": f"Research basics of {task_name}",
                "difficulty": "easy",
                "timeEstimate": 15
            },
            {   
                "id": "2",
                "title": f"Draft initial outline for {task_name}",
                "difficulty": "medium",
                "timeEstimate": 30
            },
            {
                "id": "3",
                "title": f"Complete deep work session on {task_name}",
                "difficulty": "hard",
                "timeEstimate": 60
            }
        ]
    }
    return mock_result

if __name__ == "__main__":
    
    # Read the task name from the command line argument
    if len(sys.argv) > 1:
        input_task = sys.argv[1]
    else:
        input_task = "Unknown"

    # Process the task
    result = decompose_task(input_task)

    # Print the result as JSON so electron can read it
    print(json.dumps(result))
    sys.stdout.flush()
