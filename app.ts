import dotenv from "dotenv";
import {App} from "octokit";
import {createNodeMiddleware} from "@octokit/webhooks";
import fs from "fs";
import http from "http";

import {request} from 'gaxios';

dotenv.config();

const appId = process.env.APP_ID as string
const webhookSecret = process.env.WEBHOOK_SECRET as string 
const privateKeyPath = process.env.PRIVATE_KEY_PATH as string
const privateKey = fs.readFileSync(privateKeyPath, "utf8");
const jenkins_path = process.env.JENKINS_PATH as string
const jenkins_job_token = process.env.JENKINS_JOB_TOKEN as string
const jenkins_user = process.env.JENKINS_USER as string
const jenkins_token = process.env.JENKINS_TOKEN as string

const app = new App({
  appId: appId,
  privateKey: privateKey,
  webhooks: {
    secret: webhookSecret
  }
});

async function handleJobCheck({octokit, payload, check, job_id} : {octokit: any, payload: any, check: any, job_id: number}){
  console.log("handleJobCheck")
  const jenkins_url = `${jenkins_path}/${job_id}/api/json`
  let job_success = false
  let jenkins_job_finished = false
  
  console.log(`jenkins_url: ${jenkins_url}`)
  await request({
    url: jenkins_url,
    // send auth headers Basic
    headers: {
      'Authorization': `Basic ${Buffer.from(`${jenkins_user}:${jenkins_token}`).toString('base64')}`
    }
    }
  ).then((response: any) => {
    if (!response.data.inProgress) {
      console.log('success')
      jenkins_job_finished = true
      if (response.data.result === 'SUCCESS') {
        job_success = true
      }
    }
  }).catch((error: any) => {
    // if response is 404, job is not finished, keep checking
    if (error.response && error.response.status === 404) {
      console.log('not finished')
    } else
    {
      console.error("Error in run.", error)
      jenkins_job_finished = true
      job_success = false  
    }
  })

  if(!jenkins_job_finished)
    setTimeout(handleJobCheck, 4000, {octokit, payload, check, job_id})
  else {
    console.log("changing status..")
    if(!job_success){
      // add comment
      await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        issue_number: payload.pull_request.number,
        body: "Jenkins job failed...",
        headers: {
          "x-github-api-version": "2022-11-28",
        },
      }); 

      await octokit.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        check_run_id: check.data.id,
        name: "Test Check",
        head_sha: payload.pull_request.head.sha,
        status: "completed",
        conclusion: 'failure',
        completed_at: new Date().toISOString(),
        output: {
          title: "Test Check",
          summary:  "Jenkins job failed",
        },
        headers: {
          "x-github-api-version": "2022-11-28",
        }
      });
    } else {

      await octokit.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        check_run_id: check.data.id,
        name: "Test Check",
        head_sha: payload.pull_request.head.sha,
        status: "completed",
        conclusion: 'success',
        completed_at: new Date().toISOString(),
        output: {
          title: "Test Check",
          summary:  "Jenkins job succeeded",
        },
        headers: {
          "x-github-api-version": "2022-11-28",
        }
      });

    }
  }
}

async function handlePullRequestOpened({octokit, payload} : {octokit: any, payload: any}) {
  try {
    // create a check
    const check = await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      name: "Test Check",
      head_sha: payload.pull_request.head.sha,
      status: "in_progress",
      started_at: new Date().toISOString(),
      output: {
        title: "Test Check",
        summary: "Checking jenkins job ...",
      },
      headers: {
        "x-github-api-version": "2022-11-28",
      },
    });

    // trigger jenkins job with repository name and branch name
    // ex path 
    // JENKINS_PATH="localhost:8080/job/WASAAA"

    let checkFailed = false

    let jenkins_url = `${jenkins_path}/buildWithParameters?token=${jenkins_job_token}&REPO=${payload.repository.name}&BRANCH=${payload.pull_request.head.ref}`
    console.log(`jenkins_url: ${jenkins_url}`)
    // fetch jenkins job
    //  use http user and token
    //  ex user:token

    let job_id = -1 
    await request({
      url: jenkins_url,
      method: 'POST',
      // send auth headers Basic
      headers: {
        'Authorization': `Basic ${Buffer.from(`${jenkins_user}:${jenkins_token}`).toString('base64')}`
      }
    }).then((response: any) => {
      // get Location header
      console.log(response.headers.location)      
      // should return something like: http://localhost:8080/queue/item/14/ 
      // get the queue item number
      const queue_item = response.headers.location.split('/')[5]
      console.log(`queue_item: ${queue_item}`)
      job_id = queue_item
    })      
    .catch((error: any) => {
      checkFailed = true
      console.error(error)
    })
    // await for jenkins job to finish

    console.log("checking job...")
    setTimeout(handleJobCheck, 5000, {octokit, payload, check, job_id})
  } catch (error: any) {
    await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      issue_number: payload.pull_request.number,
      body: "Failed to create check...",
      headers: {
        "x-github-api-version": "2022-11-28",
      },
    }); 
    if (error.response) {
      console.error(`Error! Status: ${error.response.status}. Message: ${error.response.data.message}`)
    }
    console.error(error)
  }
};

app.webhooks.on("pull_request.opened", handlePullRequestOpened);

app.webhooks.onError((error) => {
  if (error.name === "AggregateError") {
    console.error(`Error processing request: ${error.event}`);
  } else {
    console.error(error);
  }
});

const port = 3000;
const host = 'localhost';
const path = "/api/webhook";
const localWebhookUrl = `http://${host}:${port}${path}`;

const middleware = createNodeMiddleware(app.webhooks, {path});

http.createServer(middleware).listen(port, () => {
  console.log(`Server is listening for events at: ${localWebhookUrl}`);
  console.log('Press Ctrl + C to quit.')
});