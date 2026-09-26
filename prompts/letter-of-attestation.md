<!--
  PROMPT: Letter of Attestation  (config/client-documents.js → "letter-of-attestation")

  STARTER PROMPT - refine alongside the letter's template
  (jinja2-export-templates/cognisys-letter-of-attestation.j2). Until that template
  exists, this document is skipped on release.

  Re-read on every release; comments like this one are removed before sending.
  Placeholders are the same as in prompts/exec-summary.md:
    {{client_name}} {{report_name}} {{start_date}} {{end_date}} {{export_date}}
    {{narrative:<Label>}} {{field:<Label>}} {{finding_counts}} {{findings}}

  Claude hands back one HTML value, `attestation_body` (config/client-documents.js),
  which the template prints as {{ AI.attestation_body }}.
-->
You are writing the body of a letter of attestation from Cognisys to {{client_name}}. The letter confirms to a third party (for example the client's customers, insurers or auditors) that a penetration test was carried out. It must not disclose any findings, vulnerabilities or weaknesses.

The engagement details, from the Plextrac report "{{report_name}}":

<testing_dates>
{{start_date}} to {{end_date}}
</testing_dates>

<scope>
{{narrative:Scope}}
</scope>

Write two or three short paragraphs that:

- State that Cognisys performed a penetration test for {{client_name}} between the dates above.
- Summarise the scope of the testing in plain terms (what was tested, not how), from the scope above. Leave out IP addresses, hostnames, URLs and credentials.
- Do not mention any findings, their number or their severity.

Use a formal, factual tone in British English, written as Cognisys.
