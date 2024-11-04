// import { ComponentResource, ComponentResourceOptions, Output, getOrganization, getProject, getStack } from "@pulumi/pulumi";
import * as pulumi from "@pulumi/pulumi";
import * as pulumiservice from "@pulumi/pulumiservice";
import { local } from "@pulumi/command";
import fetch from "node-fetch";
import { profileEnd } from "console";

// Interface for StackSettings
export interface StackSettingsArgs {
  deploymentSettings?: any;
  ttlHours?: number;
  driftManagement?: boolean;
  driftScheduleCron?: string;
  teamAssignment?: string;
  stackOutputs?: string[];
  stackTags?: any;
}

// Deployment Settings API Related //
export interface StackDeploymentSettings {
  operationContext: OperationContext;
  sourceContext: SourceContext;
  gitHub: GitHub;
  source: string;
  cacheOptions: CacheOptions;
}

export interface OperationContext {
  oidc?: object;
  environmentVariables?: pulumi.Input<{ [key: string]: pulumi.Input<string> }>;
  options?: object;
}

export interface SourceContext {
  git: Git;
}

export interface Git {
  repoUrl?: string;
  branch: string;
  repoDir?: string;
  commit?: string;
}

export interface GitHub {
  repository: string;
  deployCommits: boolean;
  previewPullRequests: boolean;
  deployPullRequest?: number;
  pullRequestTemplate?: boolean;
  paths?: string[];
}

export interface CacheOptions {
  enable: boolean;
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

      let deploymentSettings: StackDeploymentSettings;
      if (response.ok) {
        deploymentSettings = await response.json();
      } else {
        let errMessage = "";
        try {
          errMessage = await response.text();
        } catch {}
        throw errMessage;
      }

      return deploymentSettings;
    };

    // Get the current deployment settings and modify if needed.
    // But, only if this is NOT a review stack. Review stacks we just leave be.
    if (!stack.includes(`pr-pulumi-${org}-${project}`)) {
      const deploymentSettings = getDeploymentSettings()
        .then((settings) => {
          // If the stack being run doesn't match the
          console.debug("Fetched Deployment settinngs");
        })
        .catch(() => {
          console.log("Unable to set TTL or Drift- deployments not enabled");
        });
    }

    //// TTL Schedule ////
    if (args.ttlHours) {
      const millisecondsToAdd = args.ttlHours * 60 * 60 * 1000;
      const nowTime = new Date();
      const nowLinuxTime = nowTime.getTime();
      const endLinuxTime = nowLinuxTime + millisecondsToAdd;
      const endDate = new Date(endLinuxTime);

      // Tweak ISO time to match expected format for TtlSchedule resource.
      // Basically takes it from YYYY-MM-DDTHH:MM:SS.mmmZ to YYYY-MM-DDTHH:MM:SSZ
      const expirationTime = endDate.toISOString().slice(0, -5) + "Z";

      new pulumiservice.TtlSchedule(
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
    }

    //// Drift Schedule ////
    if (args.driftManagement) {
      new pulumiservice.DriftSchedule(
        `${name}-driftschedule`,
        {
          organization: org,
          project: project,
          stack: stack,
          scheduleCron: args.driftScheduleCron || "0 * * * *",
          autoRemediate: false,
        },
        { parent: this }
      );
    }

    //// Team Stack Assignment ////
    // If no team name given, then assign to the "DevTeam"
    if (args.teamAssignment) {
      const teamAssignment = args.teamAssignment!;
      new pulumiservice.TeamStackPermission(
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

    if (args.stackTags) {
      const tags = args.stackTags!;
      Object.keys(tags).forEach((key: string, index: number) => {
        const value = tags[key] as string;
        new pulumiservice.StackTag(
          `stack-tag-${key.toLowerCase()}-${value.toLowerCase()}`,
          {
            organization: org,
            project: project,
            stack: stack,
            name: key,
            value: value,
          }
        );
      });
    }

    //// ESC Output advertisement
    if (args.stackOutputs) {
      const yaml = args
        .stackOutputs!.map(
          (item) => `   ${item}: \${stackRef.${stack}.${item}}`
        )
        .join("\n");

      const yamlDoc = `values:
  stackRef:
    fn::open::pulumi-stacks:
      stacks:
        ${stack}:
          stack: ${project}/${stack}
  pulumiConfig:
${yaml}`;

      const esc = new pulumiservice.Environment(`${name}-stack-env`, {
        name: `${stack}-outputs`,
        project: project,
        organization: org,
        yaml: new pulumi.asset.StringAsset(yamlDoc),
      });
    }

    this.registerOutputs({});
  }
}
