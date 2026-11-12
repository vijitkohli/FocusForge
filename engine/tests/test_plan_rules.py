import os
import sys
import unittest

from engine.tests import ENGINE_DIR  # noqa: F401  (puts engine/ on sys.path)

import plan_rules as pr

sys.path.insert(0, os.path.join(ENGINE_DIR, "evals"))
import scorers  # noqa: E402


class PlanRulesTest(unittest.TestCase):
    def test_extract_names_finds_files_identifiers_sections(self):
        names = pr.extract_names(
            "Open ass3/ass3.ipynb, load movies.csv, call parse_dates() and fix channelsCreate in Q4 and Stage 3; "
            "cite McMahan et al. 2017")
        for n in ("ass3/ass3.ipynb", "movies.csv", "parse_dates", "channelsCreate", "Q4", "Stage 3", "McMahan"):
            self.assertIn(n, names)

    def test_extract_names_ignores_generic_tools(self):
        names = pr.extract_names("Open VS Code and GitHub, then set up Node.js and read README.md in Jupyter")
        self.assertEqual(names, set())

    def test_is_vague_title_parity_with_scorers(self):
        for t in ("Study", "Work on essay", "Research topic", "Review lecture 7 slides on eigenvalues",
                  "Write the Q1 cleaning cell", ""):
            self.assertEqual(pr.is_vague_title(t), scorers.is_vague_title(t), t)
        self.assertTrue(pr.is_vague_title("Study"))
        self.assertFalse(pr.is_vague_title("Review lecture 7 slides on eigenvalues"))

    def test_ai_delegation_regex_hits_and_misses(self):
        hits = ["Ask ChatGPT to write the Q3 regression code", "Use Copilot to fix the failing cell",
                "Have AI explain the solution to Q2", "Paste the error into ChatGPT and have it fix it"]
        misses = ["Write the Q3 regression cell yourself", "Read the course AI policy",
                  "Check the forum for hints on Q2", "Explain your Q4 result in 3 sentences"]
        for h in hits:
            self.assertTrue(pr.mentions_ai_delegation(h), h)
        for m in misses:
            self.assertFalse(pr.mentions_ai_delegation(m), m)
        self.assertTrue(pr.ai_banned("Generative AI may not be used to write, debug or explain any code"))
        self.assertTrue(pr.ai_banned("AI tools may NOT be used to write, fix or explain assignment code"))
        self.assertFalse(pr.ai_banned("Use the lecture notebooks and the pandas docs"))

    def test_effort_floor_from_weight(self):
        self.assertEqual(pr.effort_floor({"weight": 15}), 540)  # 9 h (D5)
        self.assertEqual(pr.effort_floor({"weight": "20"}), 720)

    def test_effort_floor_none_without_weight(self):
        self.assertIsNone(pr.effort_floor({"kind": "exam"}))
        self.assertIsNone(pr.effort_floor(None))
        self.assertIsNone(pr.effort_floor({"weight": 0}))

    def test_grounding_section_variants(self):
        hay = "## q1 data cleaning\n## stage 2: movement"
        self.assertTrue(pr.is_grounded("Question 1", hay))
        self.assertTrue(pr.is_grounded("Stage 2", hay))
        self.assertFalse(pr.is_grounded("Q10", hay))
        self.assertFalse(pr.is_grounded("train.py", hay))


if __name__ == "__main__":
    unittest.main()
