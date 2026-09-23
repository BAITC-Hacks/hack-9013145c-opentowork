"""CLI: python -m windcast <команда>.

weather   скачать архив прогнозов погоды (кэш уже лежит в artifacts/weather)
quality   отчёт о качестве данных турбин
backtest  пошаговый бэктест 02.2025–01.2026 (~6–8 мин)
train     обучить финальную модель на всех данных до 31.01.2026
agent     прогон агента на один момент: --origin "2026-02-07 00:00"
test-period  агент по всему тестовому периоду 31.01–27.02.2026
"""

from __future__ import annotations

import argparse
import sys

import pandas as pd


def main() -> None:
    # Консоль Windows по умолчанию cp1251 — в отчётах есть «−», «…» и т. п.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(prog="windcast")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("weather")
    sub.add_parser("quality")
    b = sub.add_parser("backtest")
    b.add_argument("--first", default="2025-02")
    b.add_argument("--last", default="2026-01")
    sub.add_parser("train")
    a = sub.add_parser("agent")
    a.add_argument("--origin", required=True)
    a.add_argument("--runs", default="00,06,12,18", help="выпуски погоды для пересчёта, UTC")
    sub.add_parser("test-period")
    args = ap.parse_args()

    if args.cmd == "weather":
        from windcast.weather import coverage, download_all

        print(download_all(force=True))
        print(coverage().to_string(index=False))
    elif args.cmd == "quality":
        from windcast.scada import quality_report

        print(quality_report().to_string(index=False))
    elif args.cmd == "backtest":
        from windcast import backtest

        pred = backtest.run(args.first, args.last)
        summary = backtest.summarize_backtest(pred)
        backtest.save(pred, summary)
        backtest.export_runs(pred)
        backtest.print_summary(summary)
    elif args.cmd == "train":
        from windcast.agent.runner import train_final

        print(train_final())
    elif args.cmd == "agent":
        from windcast.agent.runner import run_agent_day

        run_agent_day(
            pd.Timestamp(args.origin), [int(r) for r in args.runs.split(",")], verbose=True
        )
    elif args.cmd == "test-period":
        from windcast.agent.runner import run_test_period

        run_test_period(verbose=True)


if __name__ == "__main__":
    main()
