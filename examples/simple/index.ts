import * as pulumi from "@pulumi/pulumi";
import { StackSettings } from "@pulumi-initech/stack-management";


export const myoutput = "myoutput string";
export const myotheroutput = "my other output"
const settings = new StackSettings("my-settings", {
    driftManagement: true,
    cronSchedule: "0/15 * * * *",
    ttlHours: 8,
    teamAssignment: "Platform",
    stackOutputs: [
        "myoutput",
        "myotheroutput",
    ], 
    stackTags: {
        "Foo": "Bar"
    }
});