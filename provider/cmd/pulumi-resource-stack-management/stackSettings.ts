// import { ComponentResource, ComponentResourceOptions, Output, getOrganization, getProject, getStack } from "@pulumi/pulumi";
import * as pulumi from "@pulumi/pulumi";
import * as pulumiservice from "@pulumi/pulumiservice";
import { local } from "@pulumi/command";
import fetch from "node-fetch";

// Interface for StackSettings
export interface StackSettingsArgs {
  ttlMinutes?: number;
  driftManagement?: string;
  deleteStack?: string;
  teamAssignment?: string;
  stackOutputs?: string[];
  stackTags?: string[];
}

// Forces Pulumi stack settings for managing TTL and other settings.
export class StackSettings extends pulumi.ComponentResource {
  constructor(
    name: string,
    args: StackSettingsArgs,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super("pulumi-initech:stack-management:stacksettings", name, args, opts);

    // Settings used below
    const npwStack = "dev"; // This is the stack that NPW creates initially.
    const org = "initech";
    const project = pulumi.getProject();
    const stack = pulumi.getStack(); // this is the stack that is running
    const stackFqdn = `${org}/${project}/${stack}`;

    // This may be the deployments automatically created access token or it may be one that is injected via config/environments
    const pulumiAccessToken =
      process.env["PULUMI_ACCESS_TOKEN"] || "notokenfound";

    //// Deployment Settings Management ////
    // If a new stack is created by the user (vs via review stacks), get the current settings and
    // configure the new stack's deployment settings based on the original settings.
    // Get current deployment settings
    const getDeploymentSettings = async () => {
      const headers = {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `token ${process.env["PULUMI_ACCESS_TOKEN"]}`,
      };
      const stackDeploymentSettingsUrl = `https://api.pulumi.com/api/stacks/${org}/${project}/${npwStack}/deployments/settings`;
      const response = await fetch(stackDeploymentSettingsUrl, {
        method: "GET",
        headers,
      });

      if (!response.ok) {
        let errMessage = "";
        try {
          errMessage = await response.text();
        } catch {}
        throw new Error(
          `failed to get deployment settings for stack, ${org}/${project}/${npwStack}: ${errMessage}`
        );
      }

      const deploymentSettings: StackDeploymentSettings = await response.json();
      return deploymentSettings;
    };

    // Get the current deployment settings and modify if needed.
    // But, only if this is NOT a review stack. Review stacks we just leave be.
    if (!stack.includes(`pr-pulumi-${org}-${project}`)) {
      const deploymentSettings = getDeploymentSettings().then((settings) => {
        // If the stack being run doesn't match the stack that NPW created in the first place,
        // modify the deployment settings to point at a branch name that matches the stack name.
        if (stack != npwStack) {
          settings.sourceContext.git.branch = "refs/heads/" + stack;
        }

        // Set the stack's deployment settings with any changes from above.
        // Maybe a no-op.
        const deploySettings = new pulumiservice.DeploymentSettings(
          `${name}-deployment-settings`,
          {
            organization: org,
            project: project,
            stack: stack,
            github: settings.gitHub,
            operationContext: {
              // Add the access token from the environment as an env variable for the deployment.
              // This overrides the deployment stack token to enable accessing the template stack's config for review stacks and to enable stack references (where needed)
              // Keeping for future reference, but this following code does not play well with the .NET SDK generation. It'll throw an error about type is not a string.
              // environmentVariables: { ...settings.operationContext.environmentVariables, ...{PULUMI_ACCESS_TOKEN: pulumi.secret(pulumiAccessToken)}}
              environmentVariables: {
                PULUMI_ACCESS_TOKEN: pulumi.secret(pulumiAccessToken),
              },
            },
            sourceContext: settings.sourceContext,
          },
          { parent: this, retainOnDelete: true }
        ); // Retain on delete so that deploy actions are maintained.

        // Deployment Caching
        // TEMPORARY - This is temporary tweak to set the Deployment Settings caching options enabled.
        // Since Deployment caching is still in preview, it is not part of the Pulumi Service SDK yet.
        // So, use the API to set the cache options.
        // Once the SDK is updated, this code can be removed and the code above modified to enable caching.
        // [*** Deployment Caching option is DISABLED until feature is GAed or close] settings.cacheOptions = {enable: true}
        const body = JSON.stringify(settings);
        const setCachingOption = new local.Command(
          "set-caching-option",
          {
            create: `curl -s \
            -H "Content-Type: application/json" \
            -H "Authorization: token ${process.env["PULUMI_ACCESS_TOKEN"]}" \
            --request POST \
            --data '${body}' \
            https://api.pulumi.com/api/stacks/${org}/${project}/${stack}/deployments/settings &> /dev/null`,
          },
          {
            parent: this,
            dependsOn: [deploySettings],
            ignoreChanges: ["create"],
          }
        );
      });
    }

    //// TTL Schedule ////
    let ttlMinutes = args.ttlMinutes;
    if (!ttlMinutes) {
      // If not set default to 8 hours from initial launch
      ttlMinutes = 8 * 60;
    }
    const millisecondsToAdd = ttlMinutes * 60 * 1000;
    const nowTime = new Date();
    const nowLinuxTime = nowTime.getTime();
    const endLinuxTime = nowLinuxTime + millisecondsToAdd;
    const endDate = new Date(endLinuxTime);
    // Tweak ISO time to match expected format for TtlSchedule resource.
    // Basically takes it from YYYY-MM-DDTHH:MM:SS.mmmZ to YYYY-MM-DDTHH:MM:SSZ
    const expirationTime = endDate.toISOString().slice(0, -5) + "Z";
    const ttlSchedule = new pulumiservice.TtlSchedule(
      `${name}-ttlschedule`,
      {
        organization: org,
        project: project,
        stack: stack,
        timestamp: expirationTime,
        deleteAfterDestroy: false,
      },
      { parent: this, ignoreChanges: ["timestamp"] }
    );

    //// Drift Schedule ////
    let remediation = true; // assume we want to remediate
    if (args.driftManagement && args.driftManagement != "Correct") {
      remediation = false; // only do drift detection
    }
    const driftSchedule = new pulumiservice.DriftSchedule(
      `${name}-driftschedule`,
      {
        organization: org,
        project: project,
        stack: stack,
        scheduleCron: "0 * * * *",
        autoRemediate: remediation,
      },
      { parent: this }
    );

    //// Team Stack Assignment ////
    // If no team name given, then assign to the "DevTeam"
    if (args.teamAssignment) {
      const teamAssignment = args.teamAssignment!;
      const teamStackAssignment = new pulumiservice.TeamStackPermission(
        `${name}-team-stack-assign`,
        {
          organization: org,
          project: project,
          stack: stack,
          team: teamAssignment,
          permission: pulumiservice.TeamStackPermissionScope.Admin,
        },
        { parent: this, retainOnDelete: true }
      );
    }

    //// ESC Output advertisement
    if(args.stackOutputs) {
      const yaml = args
        .stackOutputs!.map((item) => `   ${item}: \${stackRef.${stack}.${item}}`)
        .join("\n");

      const esc = new pulumiservice.Environment(`${name}-stack-env`, {
        name: `${stack}-outputs`,
        project: project,
        organization: org,
        yaml: new pulumi.asset.StringAsset(`values:
  stackRef:
    fn::open::pulumi-stacks:
      stacks:
        ${stack}:
          stack: ${stackFqdn}
  pulumiConfig:
    ${yaml}`),
      });
    }

    this.registerOutputs({});
  }
}

// Deployment Settings API Related //
interface StackDeploymentSettings {
  operationContext: OperationContext;
  sourceContext: SourceContext;
  gitHub: GitHub;
  source: string;
  cacheOptions: CacheOptions;
}
interface OperationContext {
  oidc?: object;
  environmentVariables?: pulumi.Input<{ [key: string]: pulumi.Input<string> }>;
  options?: object;
}
interface SourceContext {
  git: Git;
}
interface Git {
  branch: string;
  repoDir?: string;
}
interface GitHub {
  repository: string;
  deployCommits: boolean;
  previewPullRequests: boolean;
  deployPullRequest?: number;
  pullRequestTemplate?: boolean;
  paths?: string[];
}
interface CacheOptions {
  enable: boolean;
}
