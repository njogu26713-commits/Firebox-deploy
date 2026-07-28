---
name: Azure deployment artifacts
description: Azure App Service source-control registration is not an application deployment guarantee.
---

# Azure App Service deployment artifacts

## Rule
Treat Azure App Service source-control setup as separate from artifact delivery. A successful app/resource creation or source-control registration does not prove files reached `/home/site/wwwroot`.

**Why:** Azure can remain healthy while serving its default placeholder page when no package was uploaded or the build/deployment operation failed asynchronously.

**How to apply:** Explicitly clone and build the repository, upload a ZIP/OneDeploy artifact, poll the deployment result, configure and verify startup, then verify a deployed application file before reporting success. Preserve Kudu/Azure response bodies and deployment logs on failure.