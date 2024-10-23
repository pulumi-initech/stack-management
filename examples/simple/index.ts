import * as pulumi from "@pulumi/pulumi";
import { StackSettings } from "@pulumi-initech/stack-management";


export const myoutput = "myoutput string";
const settings = new StackSettings("my-settings", {
    stackOutputs: [
        "myoutput"
    ]
});