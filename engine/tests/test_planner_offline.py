import json
import unittest
from datetime import date, timedelta
from types import SimpleNamespace
from unittest import mock

from engine.tests import ENGINE_DIR  # noqa: F401

import main
import planner

TODAY = date(2026, 11, 11)


def d(n):
    return (TODAY + timedelta(days=n)).isoformat()


def reply(obj):
    content = obj if isinstance(obj, str) else json.dumps(obj)
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content))])


def good_plan(mid="m1", first_title="Open the spec and read Q1"):
    steps = [{"id": "s1", "title": first_title, "difficulty": "easy", "timeEstimate": 5,
              "scheduledDate": d(0), "milestoneId": mid}]
    for i in range(2, 8):
        steps.append({"id": f"s{i}", "title": f"Write step {i} of the Q1 cleaning in the notebook",
                      "difficulty": "medium", "timeEstimate": 15, "scheduledDate": d(1), "milestoneId": mid})
    return {
        "message": "ok", "originalTask": "Assignment 3",
        "milestones": [
            {"id": "m1", "title": "Clean the data", "estimateMinutes": 300, "doneWhen": "Q1 done", "targetDate": d(3), "status": "active"},
            {"id": "m2", "title": "Explore", "estimateMinutes": 300, "doneWhen": "Q2 done", "targetDate": d(8), "status": "todo"},
            {"id": "m3", "title": "Model and write up", "estimateMinutes": 400, "doneWhen": "submitted", "targetDate": d(12), "status": "todo"},
        ],
        "currentMilestoneId": mid, "coversRest": False, "prerequisites": [], "subtasks": steps,
        "assumptions": [],
    }


def payload(**kw):
    p = {
        "mode": "plan", "planModel": "cliproxy/test-model", "today": TODAY.isoformat(),
        "item": {"id": "x", "name": "DATA9001", "category": "Learning", "kind": "deadline"},
        "task": {"id": "t1", "title": "Assignment 3", "deadline": d(14), "deadlineKind": "hard", "scope": "deliverable",
                 "assessment": {"weight": 15, "kind": "assignment"}},
        "contextPack": {"text": "=== FILE F1: c/spec.md (brief, modified 2026-11-10) ===\nQ1 Q2 Q3 Q4\n=== END F1 ===",
                        "files": [{"id": "F1", "label": "c/spec.md", "kind": "brief"}]},
        "digest": {"goal": "Finish assignment 3", "openItems": [], "dueDates": [], "constraints": []},
        "userProfile": "", "contextLedger": "", "estimateRatio": 1.6,
    }
    p.update(kw)
    return p


class PlannerOfflineTest(unittest.TestCase):
    def setUp(self):
        self.calls = []
        env = mock.patch.dict("os.environ", {"CLIPROXY_API_KEY": "test"})
        env.start()
        self.addCleanup(env.stop)

    def fake(self, *replies):
        queue = list(replies)

        def _complete(**kwargs):
            self.calls.append(kwargs)
            return reply(queue.pop(0))
        p = mock.patch.object(main, "_complete", side_effect=_complete)
        p.start()
        self.addCleanup(p.stop)

    def test_context_sufficient_true_with_goal_and_spec(self):
        self.assertTrue(planner.context_sufficient({"goal": "x"}, {"files": [{"kind": "brief"}]}))
        self.assertTrue(planner.context_sufficient({"goal": "x", "dueDates": [{"what": "a"}]}, {}))

    def test_context_sufficient_false_goal_only(self):
        self.assertFalse(planner.context_sufficient({"goal": "x"}, {"files": [{"kind": "vault"}]}))
        self.assertFalse(planner.context_sufficient(None, {}))

    def test_plan_returns_clarifying_without_context(self):
        self.fake("What would finished look like for you?")
        out = planner.handle_plan_mode(payload(contextPack=None, digest=None, task={"title": "Learn piano"}))
        self.assertEqual(out["status"], "clarifying")
        self.assertTrue(out["message"].endswith("?"))
        self.assertEqual(len(self.calls), 1)

    def test_plan_uses_answer_and_plans(self):
        self.fake(good_plan())
        out = planner.handle_plan_mode(payload(contextPack=None, digest=None,
                                               task={"title": "Learn piano", "deadline": d(14)},
                                               allowedNames=["Q1", "Q2"],
                                               messages=[{"role": "user", "content": "Play one song by ear"}]))
        self.assertEqual(out["status"], "complete")
        self.assertIn("Play one song by ear", self.calls[0]["messages"][0]["content"])

    def test_repair_called_once_on_hard_issue(self):
        bad = good_plan()
        bad["milestones"][1]["doneWhen"] = ""
        self.fake(bad, good_plan())
        out = planner.handle_plan_mode(payload())
        self.assertEqual(out["status"], "complete")
        self.assertEqual(len(self.calls), 2)
        self.assertTrue(out["validation"]["repaired"])
        self.assertIn("MILESTONE_FIELD", self.calls[1]["messages"][-1]["content"])

    def test_no_repair_when_valid(self):
        self.fake(good_plan())
        out = planner.handle_plan_mode(payload())
        self.assertEqual(len(self.calls), 1)
        self.assertFalse(out["validation"]["repaired"])
        self.assertEqual(out["data"]["currentMilestoneId"], "m1")
        self.assertTrue(out["message"].startswith("Here's the whole job in 3 parts"))

    def test_second_failure_salvages_and_reports(self):
        bad = good_plan()
        for s in bad["subtasks"][1:]:
            s["timeEstimate"] = 90
        self.fake(bad, bad)
        out = planner.handle_plan_mode(payload())
        self.assertEqual(out["status"], "complete")
        self.assertTrue(out["validation"].get("salvaged"))
        self.assertEqual(len(out["data"]["milestones"]), 3)

    def test_expand_returns_only_target_milestone_steps(self):
        existing = good_plan()
        existing["milestones"][0]["status"] = "done"
        existing["milestones"][1]["status"] = "active"
        for s in existing["subtasks"]:
            s["status"] = "done"
        batch = {"subtasks": [dict(s, id=f"x{i}", milestoneId="m2") for i, s in enumerate(good_plan()["subtasks"])],
                 "coversRest": True, "estimateMinutes": None}
        self.fake(batch)
        out = planner.handle_plan_mode(payload(mode="expand", existingPlan=existing, milestoneId="m2"))
        self.assertEqual(out["status"], "expanded")
        self.assertNotIn("milestones", out["data"])
        self.assertTrue(all(s["milestoneId"] == "m2" for s in out["data"]["subtasks"]))
        self.assertTrue(out["data"]["coversRest"])

    def test_replan_keeps_done_milestones(self):
        existing = good_plan()
        existing["milestones"][0]["status"] = "done"
        reply_plan = good_plan(mid="m2")
        reply_plan["milestones"] = reply_plan["milestones"][1:]  # model dropped the done one
        self.fake(reply_plan)
        out = planner.handle_plan_mode(payload(mode="replan", existingPlan=existing, request="lighter this week"))
        self.assertEqual(out["status"], "updated")
        self.assertEqual(out["data"]["milestones"][0]["id"], "m1")
        self.assertEqual(out["data"]["milestones"][0]["status"], "done")
        self.assertIn("lighter this week", self.calls[0]["messages"][0]["content"])

    def test_old_modes_unaffected_by_dispatch(self):
        with mock.patch.object(main, "run_split_phase", return_value=("ok", [{"title": "a"}])) as split:
            self.assertEqual(main.handle_split({"mode": "split", "planModel": "cliproxy/x"})["status"], "split")
            split.assert_called_once()
        with mock.patch.object(main, "run_mutation_phase", return_value=("Shorter", {"subtasks": []})) as mut:
            out = main.handle_chat_turn({"messages": [{"role": "user", "content": "shorter"}], "model": "cliproxy/x",
                                         "currentChecklist": {"subtasks": []}, "deadline": d(5)})
            self.assertEqual(out["status"], "updated")
            self.assertEqual(mut.call_args.kwargs["deadline_str"], d(5))

    def test_pace_block_present_in_plan_prompt(self):
        self.fake(good_plan())
        planner.handle_plan_mode(payload())
        self.assertIn("STUDENT'S REAL PACE", self.calls[0]["messages"][0]["content"])

    def test_ai_ban_detected_from_pack(self):
        p = payload(contextPack={"text": "AI tools may NOT be used to write assignment code.",
                                 "files": [{"id": "F1", "label": "c/CONTEXT.md", "kind": "context"}]})
        self.assertTrue(planner.build_context(p, "plan").ai_banned)
        self.assertFalse(planner.build_context(payload(), "plan").ai_banned)


class AddendumTest(unittest.TestCase):
    def test_uninformative_replies_stop_asking(self):
        for text in ("idk, all of it I guess", "not sure honestly", "idk", "I don't know, just give me something to start with."):
            self.assertTrue(main._reply_is_uninformative(text), text)
        for text in ("MATH1131", "No, the exam is on Friday at 9", "Chicago footnotes and 8 sources", ""):
            self.assertFalse(main._reply_is_uninformative(text), text)
        msgs = [{"role": "user", "content": "need to study"}, {"role": "assistant", "content": "Which course?"},
                {"role": "user", "content": "idk"}]
        self.assertTrue(main._should_stop_asking(msgs))
        self.assertFalse(main._should_stop_asking(msgs[:1]))

    def test_refile_moves_unstarted_work_out_of_milestones(self):
        notes = main._refile_notes([
            {"section": "Milestones & Completed Work", "note": "Has an essay due Friday, not started"},
            {"section": "Milestones & Completed Work", "note": "Already collected the pendulum data"},
        ])
        self.assertEqual(notes[0]["section"], "Constraints & Specifications")
        self.assertEqual(notes[1]["section"], "Milestones & Completed Work")

    def test_completed_ids_filtered_to_open_items(self):
        cl = {"subtasks": [{"id": "1", "status": "done"}, {"id": "2", "isCompleted": False}],
              "prerequisites": [{"id": "p1", "isCompleted": False}]}
        self.assertEqual(main._valid_completed_ids(["1", "2", "p1", "zz", "2"], cl), ["2", "p1"])
        self.assertEqual(main._valid_completed_ids(None, cl), [])

    def test_mutation_prompt_has_date_and_deadline(self):
        seen = {}

        def _complete(**kwargs):
            seen["prompt"] = kwargs["messages"][0]["content"]
            return reply({"message": "ok", "subtasks": [], "completedIds": ["2"]})
        with mock.patch.object(main, "_complete", side_effect=_complete):
            _summary, data = main.run_mutation_phase(
                [{"role": "user", "content": "push after Friday"}],
                {"subtasks": [{"id": "2", "title": "x", "isCompleted": False}]}, "", "", "cliproxy/x",
                deadline_str="2099-01-01")
        self.assertIn("CURRENT DATE:", seen["prompt"])
        self.assertIn("DEADLINE: 2099-01-01", seen["prompt"])
        self.assertEqual(data["completedIds"], ["2"])


if __name__ == "__main__":
    unittest.main()
