import os, sys, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from nowchat import normalise, build_prompt


STEPS = [{"id": "s1", "item": "Thesis", "kind": "deadline", "task": "Presentation", "step": "Read the rubric",
          "minutes": 15, "difficulty": "easy", "due": "2026-11-29", "dueKind": "tentative", "touched": "today"}]


class NowChatTests(unittest.TestCase):
    def test_unknown_pick_is_dropped(self):
        r = normalise({"message": "Try this", "pick": "s99", "replies": ["a"]}, {"steps": STEPS})
        self.assertIsNone(r["pick"])

    def test_valid_pick_and_reply_cap(self):
        r = normalise({"message": "Read the rubric.", "pick": "s1", "replies": ["a", "b", "c", "d"]}, {"steps": STEPS})
        self.assertEqual(r["pick"], "s1")
        self.assertEqual(len(r["replies"]), 3)

    def test_empty_message_gets_fallback(self):
        r = normalise({"pick": None}, {"steps": STEPS})
        self.assertTrue(r["message"])

    def test_prompt_lists_steps_and_tentative(self):
        p = build_prompt({"steps": STEPS, "now": "Thu 19 Nov 13:40"})
        self.assertIn("s1 | Thesis (deadline item)", p)
        self.assertIn("(tentative)", p)


if __name__ == "__main__":
    unittest.main()
