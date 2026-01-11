# engine/main.py
# Houses the main logic for the system

import sys, json
import os
from litellm import completion
from dotenv import load_dotenv
from datetime import datetime

# LLMs
DEFAULT_MODEL = "gemini/gemini-3-flash-preview"
# Load the environment variables from the .env file
load_dotenv()


def decompose_task(task_name, deadline_str, depth, model_name=DEFAULT_MODEL):
    # print(f"DEBUG: Using Model -> {model_name}", file=sys.stderr)

    # Core Decomposition logic
    try:

        today = datetime.now()
        deadline = datetime.strptime(deadline_str, "%Y-%m-%d")
        days_remaining = (deadline - today).days + 1

        if days_remaining < 1: days_remaining = 1

    except:
        today = datetime.now()
        days_remaining = 7 
        deadline_str = "Next Week"

    current_date_str = today.strftime("%Y-%m-%d")

    # System Prompt
    # Ask the AI to strictly match the JSON format, returning raw JSON
    system_instruction = (
        "You are an expert Productivity Coach focused on building momentum. "
        "Your goal is to break ANY user intent into a 'No-Fail' execution checklist.\n\n"
        "Your goal is to break a large scary task into tiny, non-threatening micro-steps that make the user want to start IMMEDIATELY.\n\n"
        
        f"--- CONTEXT ---\n"
        f"TASK: {task_name}\n"
        f"CURRENT DATE: {current_date_str}\n"
        f"DEADLINE: {deadline_str} ({days_remaining} days remaining)\n"
        f"DEPTH: {depth} (If 'Deep', provide detailed 5-10 min increments. If 'Brief', high-level milestones).\n\n"

        "--- CRITICAL INSTRUCTIONS ---\n"
        "1. HIDDEN DEPENDENCY CHECK (Gap Analysis): Analyze the request for missing prerequisites. "
        "   (Example: If user says 'Paint the room', you must add 'Buy masking tape' and 'Move furniture' first. "
        "   If user says 'Build an App', you must add 'Sketch wireframes' and 'Setup Git repo').\n"
        "2. THE 10-MINUTE RULE: Break 'big' nebulous tasks into concrete, low-friction actions. "
        "   Avoid vague verbs like 'Study' or 'Work on'. Use specific verbs like 'Read Chapter 1', 'Write Introduction', 'Email X'.\n"
        "3. LOGICAL FLOW: Start with setup/prep tasks (momentum builders), then moving to core work, then review/polishing.\n"
        "4. QUANTITY: Provide at least 10+ subtasks if Depth is 'Deep' or 5 subtasks if Depth is 'Brief'. \n"
        "5. SCHEDULING: Distribute tasks logically across the available days. Do not dump everything on the deadline.\n\n"

        "--- JSON FORMAT ---\n"
        "Return ONLY a raw JSON object with this exact structure:\n"
        "{\n"
        '  "originalTask": "string",\n'
        '  "subtasks": [\n'
        '    {\n'
        '      "id": "1",\n'
        '      "title": "Micro-step title",\n'
        '      "difficulty": "easy/medium/hard",\n'
        '      "timeEstimate": integer_minutes,\n'
        '      "scheduledDate": "YYYY-MM-DD"\n'
        '    }\n'
        '  ]\n'
        "}"
    )

    try:
        # AI call
        response = completion(
            model=model_name,
            messages=[
                {"role": "system", "content": system_instruction},
                {"role": "user", "content": f"Here is the task: {task_name}"}
            ],

            # Get the response as JSON output
            response_format={"type": "json_object"},
            temperature=0.7
        )

        # Parse the result
        content = response.choices[0].message.content
        
        # Verify it is valid JSON before returning
        return json.loads(content)


    except Exception as e:
            return {
                "originalTask": task_name,
                "subtasks": [
                    {
                        "id": "error",
                        "title": f"AI Generation Failed: {str(e)}",
                        "difficulty": "hard",
                        "timeEstimate": 0,
                        "scheduledDate": current_date_str
                    }
                ]
            }


if __name__ == "__main__":

    # Read arguments from Electron
    # sys.argv[0] is the script name
    # sys.argv[1] is the Task Name
    # sys.argv[2] is the Model Name (optional)
    
    input_task = sys.argv[1] if len(sys.argv) > 1 else "Unknown"
    input_deadline = sys.argv[2] if len(sys.argv) > 2 else datetime.now().strftime("%Y-%m-%d")
    input_depth = sys.argv[3] if len(sys.argv) > 3 else "Brief"
    input_model = sys.argv[4] if len(sys.argv) > 4 else DEFAULT_MODEL
    
    # Process the task
    result = decompose_task(input_task, input_deadline, input_depth, input_model)

    # Print the result as JSON so electron can read it
    print(json.dumps(result))
    sys.stdout.flush()
