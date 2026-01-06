# Description, motivation, and context

<!--
Describe what you did and why it is useful. If the Shortcut ticket provides
sufficient details, you do not need to duplicate them here. You may reference
more than one ticket.
-->

---

[Link to Shortcut ticket](https://app.shortcut.com/metarouter/story/###)

<!--
The following checklist provides reminders that apply to most changes. If an
item does not apply to your change, check the box anyway so the reviewer knows
you considered it and the merge request history contains a record of it.
-->

- [ ] Includes applicable tests, documentation, and any other supporting items.
- [ ] Review environment passes Cypress and acceptance tests.
- [ ] Meets applicable security and/or compliance requirements.
- [ ] Contains a proper [commit message](https://juhani.gitlab.io/go-semrel-gitlab/commit-message/)
  and includes a single commit after fixup or squash of intermediate commits.

---

<!--
See commit message structure below for details. Consider rebasing on the master
branch to prevent merge conflicts.
-->

# Known limitations, trade-offs, and technical debt

<!--
Does this change introduce any limitations, trade-offs, and/or technical debt?
If so, make a ticket to track future work and add a link to it here. If this
section does not apply, specify "N/A" here.
-->

<!--
# Commit message structure

GitLab adds the merge request title and a link to the merge request to the
merge commit message. Merge request titles must use the following structure for
semantic versioning.

`type(scope): subject` or `type: subject`

Default types:

* Minor bump: `feat`
* Patch bump: `fix, refactor, perf, docs, style, test`

Scopes typically refer to the section and/or type of code this change impacts.
For example, `terraform` for Terraform, `forwarder` for forwarders, and
`control-api` for the control API. If a change impacts more than one section
and/or type of code, use multiple scopes with a `+` in between them. For
example, a Terraform and Helm change would use `terraform+helm`.
-->
