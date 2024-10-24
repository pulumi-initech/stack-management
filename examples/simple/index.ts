import * as pulumi from "@pulumi/pulumi";
import { StackSettings } from "@pulumi-initech/stack-management";


export const myoutput = "myoutput string";
export const myotheroutput = "my other output"
const settings = new StackSettings("my-settings", {
    stackOutputs: [
        "myoutput",
        "myotheroutput",
    ]
});