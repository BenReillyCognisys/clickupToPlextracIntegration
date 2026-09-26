<!--
  PROMPT: Executive Summary Report  (config/client-documents.js → "exec-summary")

  This whole file is sent to Claude as the request, after the placeholders below are
  filled in. It is re-read on every release: save a change and the next release (or
  `node scripts/preview-client-documents.js <clientId> <reportId>`) uses it.
  Comments like this one are removed before sending.

  Placeholders - only the ones used here are sent to Claude:
    {{client_name}}            the client's name
    {{report_name}}            the Plextrac report's name
    {{start_date}}             testing start date, e.g. 1 September 2026
    {{end_date}}               testing end date
    {{export_date}}            today's date (the export)
    {{narrative:<Label>}}      any Plextrac narrative, e.g. {{narrative:Scope}}
    {{field:<Label>}}          any report custom field, e.g. {{field:Author 1}}
    {{finding_counts}}         number of findings per severity
    {{findings}}               "- [Severity] Title" per finding (titles only, no write-ups)
  A placeholder whose data is missing on the report stops the document (flagged in
  Slack) rather than sending Claude a blank.

  What Claude must hand back is fixed in config/client-documents.js ("outputs"): here,
  one HTML value, `executive_summary`, which replaces the Executive Summary narrative
  in the PDF. You don't need to describe the output format in this prompt.
-->
You are preparing the executive summary for a standalone Executive Summary Report that Cognisys will send to {{client_name}}. It is taken from the full penetration test report "{{report_name}}" (testing from {{start_date}} to {{end_date}}), and will be read by senior, non-technical stakeholders who will not see the full report.

Below is the executive summary as written in the full report, followed by the number of findings at each severity.

<full_report_executive_summary>
{{narrative:Executive Summary}}
</full_report_executive_summary>

<finding_counts>
{{finding_counts}}
</finding_counts>

Rewrite the executive summary so it stands on its own for this audience:

- Keep every fact, figure, conclusion and recommendation that is in the original. Do not add findings, risks, numbers or advice that are not in the text above.
- Where the original refers to sections, tables or findings elsewhere in the full report, reword so the sentence makes sense without them.
- Explain any technical term a non-technical reader would not know, or replace it with plain language.
- Keep the tone professional, measured and factual, in British English, written as Cognisys.
- Keep it concise: about the same length as the original or shorter.
