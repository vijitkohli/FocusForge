# engine/tests: stdlib unittest suites for the planner (`npm run test:engine`).
# Engine modules import each other as top-level modules (main, plan_rules, ...),
# so put engine/ on sys.path once for every test module.
import os
import sys

ENGINE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ENGINE_DIR not in sys.path:
    sys.path.insert(0, ENGINE_DIR)
