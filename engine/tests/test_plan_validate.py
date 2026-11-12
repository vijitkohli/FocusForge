import copy
import unittest
from datetime import date, timedelta

from engine.tests import ENGINE_DIR  # noqa: F401

from plan_validate import (
    PlanContext, autofix, format_for_repair, salvage, validate, Issue,
)

TODAY = date(2026, 11, 11)


def d(n):
    return (TODAY + timedelta(days=n)).isoformat()


def ctx(**kw):
    base = dict(today=TODAY, deadline=TODAY + timedelta(days=14), deadline_kind="hard", mode="plan",
                pack_text="spec.md Q1 Q2 Q3 Q4 movies.csv ass3.ipynb", task_title="Assignment 3")
    base.update(kw)
    return PlanContext(**base)


def good_plan():
    steps = [{"id": "s1", "title": "Open the spec and read the Q1 section", "difficulty": "easy",
              "timeEstimate": 5, "scheduledDate": d(0), "milestoneId": "m1"}]
    for i in range(2, 8):
        steps.append({"id": f"s{i}", "title": f"Write part {i} of the Q1 cleaning cells in the notebook",
                      "difficulty": "medium", "timeEstimate": 15, "scheduledDate": d(i // 2), "milestoneId": "m1"})
    return {
        "originalTask": "Assignment 3",
        "milestones": [
            {"id": "m1", "title": "Clean the data (Q1)", "estimateMinutes": 180, "doneWhen": "Q1 table shows row counts",
             "targetDate": d(3), "status": "active"},
            {"id": "m2", "title": "Explore the data (Q2)", "estimateMinutes": 240, "doneWhen": "Q2 plots and discussion done",
             "targetDate": d(7), "status": "todo"},
            {"id": "m3", "title": "Model and write up (Q3, Q4)", "estimateMinutes": 420, "doneWhen": "notebook runs top to bottom",
             "targetDate": d(12), "status": "todo"},
        ],
        "currentMilestoneId": "m1",
        "coversRest": False,
        "prerequisites": [],
        "subtasks": steps,
    }


def codes(issues, unfixed_only=True):
    return {i.code for i in issues if not (unfixed_only and i.fixed)}


class ValidateTest(unittest.TestCase):
    def test_valid_plan_has_no_issues(self):
        self.assertEqual(validate(good_plan(), ctx()), [])

    def test_missing_done_when_is_hard(self):
        p = good_plan()
        p["milestones"][1]["doneWhen"] = ""
        issues = validate(p, ctx())
        self.assertIn("MILESTONE_FIELD", codes(issues))
        self.assertEqual([i.severity for i in issues if i.code == "MILESTONE_FIELD"], ["hard"])

    def test_first_step_over_5_gets_opener(self):
        p = good_plan()
        p["subtasks"][0]["timeEstimate"] = 15
        fixed, fixes = autofix(p, ctx())
        self.assertEqual(fixed["subtasks"][0]["timeEstimate"], 3)
        self.assertTrue(fixed["subtasks"][0]["title"].startswith("Open what you need for"))
        self.assertIn("FIRST_STEP_SIZE", {f.code for f in fixes})
        self.assertNotIn("FIRST_STEP_SIZE", codes(validate(fixed, ctx())))

    def test_first_step_not_today_gets_opener(self):
        p = good_plan()
        p["subtasks"][0]["scheduledDate"] = d(1)
        for s in p["subtasks"]:
            s["scheduledDate"] = max(s["scheduledDate"], d(1))
        fixed, _ = autofix(p, ctx())
        self.assertEqual(fixed["subtasks"][0]["scheduledDate"], d(0))
        self.assertEqual(validate(fixed, ctx()), [])

    def test_step_over_20_flagged(self):
        p = good_plan()
        p["subtasks"][3]["timeEstimate"] = 35
        self.assertIn("STEP_SIZE", codes(validate(p, ctx())))

    def test_dates_clamped_into_range(self):
        p = good_plan()
        p["subtasks"][2]["scheduledDate"] = d(-3)
        p["subtasks"][6]["scheduledDate"] = d(40)
        fixed, _ = autofix(p, ctx())
        dates = [s["scheduledDate"] for s in fixed["subtasks"]]
        self.assertTrue(all(d(0) <= x <= d(14) for x in dates))
        self.assertEqual(dates, sorted(dates))

    def test_target_dates_recomputed_when_unordered(self):
        p = good_plan()
        p["milestones"][0]["targetDate"] = d(10)
        p["milestones"][1]["targetDate"] = d(2)
        fixed, fixes = autofix(p, ctx())
        targets = [m["targetDate"] for m in fixed["milestones"]]
        self.assertEqual(targets, sorted(targets))
        self.assertLess(targets[-1], d(14))  # a day of buffer before a hard deadline
        self.assertNotIn("DATE_ORDER", codes(validate(fixed, ctx())))

    def test_last_milestone_buffer_soft(self):
        p = good_plan()
        p["milestones"][2]["targetDate"] = d(14)
        issues = validate(p, ctx())
        late = [i for i in issues if i.code == "LAST_MILESTONE_LATE"]
        self.assertEqual(len(late), 1)
        self.assertEqual(late[0].severity, "soft")

    def test_steps_exceeding_milestone_flagged(self):
        p = good_plan()
        p["milestones"][0]["estimateMinutes"] = 60
        self.assertIn("STEPS_EXCEED_MILESTONE", codes(validate(p, ctx())))
        fixed, _ = autofix(p, ctx())
        self.assertGreaterEqual(fixed["milestones"][0]["estimateMinutes"], 95)
        self.assertNotIn("STEPS_EXCEED_MILESTONE", codes(validate(fixed, ctx())))

    def test_step_with_foreign_milestone_flagged(self):
        p = good_plan()
        p["subtasks"][2]["milestoneId"] = "m2"
        self.assertIn("STEP_MILESTONE", codes(validate(p, ctx())))

    def test_coverage_low_soft_when_expected_known(self):
        issues = validate(good_plan(), ctx(expected_min=2400))
        low = [i for i in issues if i.code == "COVERAGE_LOW"]
        self.assertEqual(len(low), 1)
        self.assertEqual(low[0].severity, "soft")

    def test_no_coverage_check_when_unknown(self):
        self.assertNotIn("COVERAGE_LOW", codes(validate(good_plan(), ctx(expected_min=None))))

    def test_ungrounded_name_flagged(self):
        p = good_plan()
        p["subtasks"][4]["title"] = "Write train.py with the model class"
        issues = validate(p, ctx())
        self.assertIn("UNGROUNDED_NAME", codes(issues))
        self.assertTrue(any("train.py" in i.msg for i in issues))

    def test_grounded_name_ok(self):
        p = good_plan()
        p["subtasks"][4]["title"] = "Load movies.csv into ass3.ipynb and print 5 rows"
        self.assertNotIn("UNGROUNDED_NAME", codes(validate(p, ctx())))

    def test_ai_delegation_flagged_only_with_constraint(self):
        p = good_plan()
        p["subtasks"][4]["title"] = "Ask ChatGPT to write the Q1 parsing code"
        self.assertNotIn("AI_DELEGATION", codes(validate(p, ctx(ai_banned=False))))
        self.assertIn("AI_DELEGATION", codes(validate(p, ctx(ai_banned=True))))

    def test_salvage_prefers_fewer_hard_issues(self):
        bad = good_plan()
        bad["milestones"][1]["doneWhen"] = ""
        bad["milestones"][2]["estimateMinutes"] = "lots"
        good = good_plan()
        good["milestones"][0]["title"] = "Clean the data for Q1"
        plan, issues = salvage([bad, good], ctx())
        self.assertIsNotNone(plan)
        self.assertEqual(plan["milestones"][0]["title"], "Clean the data for Q1")
        self.assertEqual([i for i in issues if i.severity == "hard"], [])

    def test_salvage_keeps_valid_milestones_when_steps_bad(self):
        p = good_plan()
        for s in p["subtasks"][1:]:
            s["timeEstimate"] = 90
        plan, _issues = salvage([p], ctx())
        self.assertIsNotNone(plan)
        self.assertEqual(len(plan["milestones"]), 3)
        self.assertTrue(all(s["timeEstimate"] <= 20 for s in plan["subtasks"]))

    def test_salvage_returns_none_when_nothing_valid(self):
        plan, issues = salvage([{"milestones": "nope", "subtasks": None}, "not a dict"], ctx())
        self.assertIsNone(plan)
        self.assertTrue(issues)

    def test_format_for_repair_numbered(self):
        text = format_for_repair([Issue("STEP_SIZE", "subtasks[4]", "35 min (want 5-20)"),
                                  Issue("COVERAGE_LOW", "milestones", "too low", "soft"),
                                  Issue("DATE_RANGE", "x", "fixed already", fixed=True)])
        self.assertEqual(text.splitlines(), ["1. [STEP_SIZE] subtasks[4]: 35 min (want 5-20)",
                                             "2. [COVERAGE_LOW] milestones: too low"])

    def test_passion_horizon_used_when_no_deadline(self):
        c = ctx(deadline=None, deadline_kind="none")
        self.assertEqual(c.end, TODAY + timedelta(days=28))
        p = good_plan()
        p["milestones"][2]["targetDate"] = d(25)
        self.assertNotIn("DATE_RANGE", codes(validate(p, c)))
        p["milestones"][2]["targetDate"] = d(40)
        self.assertIn("DATE_RANGE", codes(validate(p, c)))

    def test_replan_restores_done_milestone_verbatim(self):
        done = {"id": "m1", "title": "Clean the data (Q1)", "estimateMinutes": 200, "doneWhen": "x",
                "status": "done", "completedAt": "2026-11-10T10:00:00Z"}
        p = good_plan()
        p["milestones"] = p["milestones"][1:]
        p["currentMilestoneId"] = "m2"
        for s in p["subtasks"]:
            s["milestoneId"] = "m2"
        fixed, fixes = autofix(p, ctx(mode="replan", done_milestones=[copy.deepcopy(done)]))
        self.assertEqual(fixed["milestones"][0], done)
        self.assertIn("DONE_MILESTONE_CHANGED", {f.code for f in fixes})
        self.assertEqual(fixed["currentMilestoneId"], "m2")

    def test_small_task_allows_one_milestone_and_few_steps(self):
        p = {"milestones": [{"id": "m1", "title": "Send the email", "estimateMinutes": 30, "doneWhen": "sent",
                             "targetDate": d(0), "status": "active"}],
             "currentMilestoneId": "m1", "coversRest": True, "prerequisites": [],
             "subtasks": [{"id": "s1", "title": "Open your email and start a new message", "difficulty": "easy",
                           "timeEstimate": 3, "scheduledDate": d(0), "milestoneId": "m1"},
                          {"id": "s2", "title": "Write and send the referral email with the CV attached",
                           "difficulty": "easy", "timeEstimate": 15, "scheduledDate": d(0), "milestoneId": "m1"}]}
        self.assertEqual(validate(p, ctx(deadline=TODAY + timedelta(days=1), pack_text="")), [])


if __name__ == "__main__":
    unittest.main()
