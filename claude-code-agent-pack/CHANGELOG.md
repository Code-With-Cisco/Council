# Change Log

## PRD change-propagation revision

The PRD Lead now:

- owns reverse-reference impact analysis for changed PRD sections;
- updates affected epics and story product definitions;
- preserves IDs when the deliverable remains coherent;
- creates replacement stories or epics when traceability would otherwise be
  misleading;
- blocks impacted stories pending Test Engineer revalidation;
- never edits the executable `acceptance` field;
- invalidates stale acceptance evidence and prior Reviewer verdicts;
- writes a durable PRD change notice;
- sends targeted notifications to Architect, Builder, Test Engineer, Reviewer,
  and Researcher when team messaging is available;
- produces an honest dispatch list when messaging is unavailable;
- refuses to call a PRD change complete until propagation is verified.

Builder, Reviewer, and Test Engineer now reject or revalidate work affected by
active PRD change notices.
