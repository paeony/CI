var git = require('./../hook/git_actions');
var db = require('./../db_actions');
var fs = require('fs');
var path = require('path');
var exec = require('child_process').exec;
var sync = jxcore.utils.cmdSync;
var tester = require('../internal/tester');

var eopts = {
  encoding: 'utf8',
  timeout: 1200000, // 20mins
  maxBuffer: 1e9,
  killSignal: 'SIGTERM'
};

var builderBusy = false;
var builderReset = false;
var lastStartTime = 0;
var activeJobId = 0;
var cancelJobId = 0;
var vmChild = null;

var stopVM = function (cb) {
  var vm = "/Applications/VMware\\ Fusion.app/Contents/Library/vmrun";
  exec(vm + " stop ~/Desktop/Virtual\\ Machines/OSXDEV.vmwarevm/OSXDEV.vmx", eopts, function (err, out, stderr) {
    if (err)
      logme("Error stopping VM", err, out, stderr, "red");
    cb(err, out, stderr);
  });
};

var resetVM = function (cb) {
  var vm = "/Applications/VMware\\ Fusion.app/Contents/Library/vmrun";
  vmChild = exec(vm + " revertToSnapshot ~/Desktop/Virtual\\ Machines/OSXDEV.vmwarevm/OSXDEV.vmx snapshot0", eopts, function (err, stdout, stderr) {
    vmChild = null;
    if (err) {
      logme("Error: Something went terribly bad.. ", err + "\n" + stdout + "\n" + stderr, "red");
      stopVM(function () {
        setTimeout(function () {
          resetVM(cb);
        }, 1000);
      });

      return;
    }

    logme("VM: Revert snapshot", "green");
    // check queue if there is something start

    vmChild = exec(vm + " start ~/Desktop/Virtual\\ Machines/OSXDEV.vmwarevm/OSXDEV.vmx", eopts, function (err, stdout, stderr) {
      vmChild = null;
      if (err) {
        logme("Error: Something went terribly bad... ", err + "\n" + stdout + "\n" + stderr, "red");
        stopVM(function () {
          setTimeout(function () {
            resetVM(cb);
          }, 1000);
        });
        return;
      }
      logme("VM: Start OS", "green");

      builderReset = false;
      cb();
    });
  });
};

var updateScripts = function (job, cmd) {
  var arrFrom = cmd.from;
  var arrTo = cmd.to;

  var serverScript = "";
  if (job.config.serverScript && job.config.serverScript.length) {
    serverScript = "mkdir -p builds/server_" + job.prId + "/;ERROR_ABORT;\n";
    serverScript += "scp -r thali@192.168.1.20:~/Github/testBuild/" + job.config.serverScript + " builds/server_" + job.prId + "/ ;ERROR_ABORT"
  }

  for (var i = 0; i < arrFrom.length; i++) {
    var data = fs.readFileSync(__dirname + "/" + arrFrom[i]) + "";
    var url = "https://github.com/" + job.user + "/" + job.repo + "/archive/" + job.branch + ".zip";
    data = data.replace("{{REPOSITORY}}", url);

    data = data.replace("{{BRANCH_NAME}}", job.branch);
    data = data.replace("{{COMBINED_NAME}}", job.repo + "-" + job.branch);

    var scr = job.config.build.substr ? job.config.build : (cmd.ios ? job.config.build.ios : job.config.build.android);
    data = data.replace("{{BUILD_SCRIPT_PATH}}", scr);
    data = data.replace("{{BUILD_SCRIPT}}", scr);

    scr = job.config.binary_path.substr ? job.config.binary_path : (cmd.ios ? job.config.binary_path.ios : job.config.binary_path.android);
    data = data.replace("{{BUILD_PATH}}", scr).replace("{{BUILD_PATH}}", scr);

    data = data.replace("{{BUILD_INDEX}}", cmd.index).replace("{{BUILD_INDEX}}", cmd.index);
    data = data.replace("{{BUILD_PR_ID}}", job.prId).replace("{{BUILD_PR_ID}}", job.prId);


    data = data.replace("{{CENTRALSCRIPTCOPY}}", serverScript);


    fs.writeFileSync(__dirname + "/" + arrTo[i], data);
  }
};

var jobErrorReportAndRemove = function (job, err, stdout, stderr) {
  var msg = err + "\n\n" + stdout + "\n\n" + stderr;
  logme("Error: ", msg, "(JOB ID:" + job.prId + ")", "red");

  if (msg.length > 12 * 1024) {
    var left = msg.substr(0, 6 * 1024);
    msg = left + "\n...\n" + msg.substr(msg.length - (6 * 1024));
  }

  // report on git
  if (job.prNumber) {
    var opts = {
      user: job.user,
      repo: job.repo,
      number: job.prNumber,
      body: "Test Server build has failed. See error details below; \n```" + msg + "\n```"
    };
    git.createComment(opts);
  } else {
    git.createIssue(job.user, job.repo, "Test Server build has failed", "Error Message : \n\n" + msg);
  }
  db.removeJob(job);

  stopVM(function () {
    builderBusy = false;
    builderReset = false;
    activeJobId = 0;
  });
};

var gitLog = "";
var runBuild = function (cmds, job, index, cb) {
  if (cancelJobId == job.prId)
    return;

  if (index == 0) gitLog = "";

  var cmd = cmds[index];

  if (!cmd.sync)
    updateScripts(job, cmd);

  exec("cd " + __dirname + ";" + cmd.cmd, eopts, function (err, stdout, stderr) {
    if (cancelJobId == job.prId)
      return;

    // cleanup the script file
    if (!cmd.sync && cmd.to) {
      for (var i = 0; i < cmd.to.length; i++) {
        sync("rm " + __dirname + "/" + cmd.to[i])
      }
    }

    if (err) {
      jobErrorReportAndRemove(job, err, stdout, stderr);
      cb(err);
    } else {
      gitLog += stdout + "\n" + stderr + "\n";
      index++;
      if (index < cmds.length) {
        runBuild(cmds, job, index, cb);
      } else {
        if (job.prNumber) {
          git.createGist("Test " + job.prId + " Build Logs", gitLog, function (err, res) {
            gitLog = "";
            if (err) {
              var opts = {
                user: job.user,
                repo: job.repo,
                number: job.prNumber,
                body: "Build is completed without an error but couldn't create a gist."
              };
              git.createComment(opts);
            } else {
              var url = res.html_url;
              tester.logIssue(job, "Test " + job.prId + " build process is completed", "See " + url + " for the logs");
            }
          });
        }
        cb();
      }
    }
  });
};

var buildJob = function (job) {
  var setInter = setTimeout(function () {
    // something went wrong and app couldn't reset VM
    if (vmChild) {
      vmChild.kill();
    }
  }, 30000);

  // open vm
  resetVM(function () {
    // clear vmChild timer
    clearInterval(setInter);

    // build
    var cmds = [];
    cmds.push({index: 0, cmd: "rm -rf build_android/;mkdir build_android;rm -rf build_ios;mkdir build_ios", sync: 1});
    cmds.push({
      index: 0, cmd: "ssh thali@192.168.1.20 'bash -s' < clone.sh", from: ["clone__.sh"], to: ["clone.sh"]
    });

    if (job.target == "all" || job.target == "android") {
      cmds.push({
        index: 0,
        cmd: "ssh thali@192.168.1.20 'bash -s' < build.sh",
        android: 1,
        from: ["build__.sh"],
        to: ["build.sh"]
      });
      cmds.push({
        index: 0,
        cmd: "chmod +x sign_droid.sh;./sign_droid.sh",
        android: 1,
        from: ["sign_droid__.sh", "pack_android__.sh"],
        to: ["sign_droid.sh", "pack_android.sh"]
      });
    }

    if (job.target == "all" || job.target == "ios") {
      cmds.push({
        index: 0,
        cmd: "ssh thali@192.168.1.20 'bash -s' < build.sh",
        ios: 1,
        from: ["build__.sh"],
        to: ["build.sh"]
      });
      cmds.push({
        index: 0,
        cmd: "chmod +x sign_ios.sh; ./sign_ios.sh",
        ios: 1,
        from: ["sign_ios__.sh", "pack_ios__.sh"],
        to: ["sign_ios.sh", "pack_ios.sh"]
      });
    }

    cmds.push({
      index: 0,
      cmd: "chmod +x copy_server.sh;./copy_server.sh",
      android: 1,
      ios: 1,
      from: ["copy_server__.sh"],
      to: ["copy_server.sh"]
    });

    logme("Running builds for job:", job.prId);
    runBuild(cmds, job, 0, function (err) {
      if (err || cancelJobId == job.prId)
        return;

      logme("Build finished", "green");
      activeJobId = 0;
      cancelJobId = 0;

      // move builds
      var prPath = "builds/" + job.prId;
      exec("cd " + __dirname + "; rm -rf " + prPath + "; mkdir -p " + prPath + "; mv build_ios/ " + prPath + "; mv build_android/ " + prPath, eopts, function (err, stdout, stderr) {
        if (err) {
          logme("something happened and couldn't move the builds?", err, stdout, stderr, "red");
          jobErrorReportAndRemove(job, err, stdout, stderr);
        } else {
          // save job
          job.compiled = true;
          db.updateJob(job);
        }

        if (job.target != "all") {
          if (job.target == 'ios')
            sync("cd " + __dirname + "; rm -rf " + prPath + "/build_android");
          else
            sync("cd " + __dirname + "; rm -rf " + prPath + "/build_ios");
        }

        builderReset = true;

        stopVM(function () {
          builderBusy = false;
          builderReset = false;
        });
      });
    });
  });
};

exports.IsActive = function (prId) {
  return activeJobId == prId;
};

exports.cancelIfActive = function (prId) {
  logme("checking for cancel ", prId, activeJobId, "yellow");
  if (activeJobId == prId) {
    logme("Cancelling job ", prId, "yellow");
    cancelJobId = prId;
    var vm = "/Applications/VMware\\ Fusion.app/Contents/Library/vmrun";
    builderReset = true;

    exec(vm + " stop revertToSnapshot ~/Desktop/Virtual\\ Machines/OSXDEV.vmwarevm/OSXDEV.vmx", eopts, function () {
      builderBusy = false;
      builderReset = false;
      activeJobId = 0;
    });
  }
};

var vmTask = function () {
  if (builderBusy) {
    // a build operation can not take longer than 30 minutes
    if (Date.now() - lastStartTime > 1800000) {
      if (builderReset)
        return;

      builderReset = true;
      stopVM(function () {
        builderBusy = false;
        builderReset = false;
        activeJobId = 0;
      });
    }

    return;
  }

  // anything in the queue ?
  var job = db.getJob(true);

  if (!job || job.noJob) return;

  // start VM from snapshot
  builderBusy = true;
  lastStartTime = Date.now();

  activeJobId = job.prId;
  buildJob(job);
};

setInterval(vmTask, 2000);