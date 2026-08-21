const Deployment = require('../models/Deployment');
let ioInstance = null;

function attachIO(io) {
  ioInstance = io;
}

/** Broadcast a single log line to clients watching this deployment's Socket.IO room. */
async function broadcast(deployment, level = 'info', message = '') {
  const entry = { ts: new Date(), level, message };
  await Deployment.updateOne({ _id: deployment._id }, { $push: { logs: entry } }).catch(() => {});
  if (ioInstance) {
    ioInstance.to(`deployment:${deployment._id}`).emit('log:line', {
      deploymentId: deployment._id.toString(),
      ...entry,
    });
  }
}

/** Update deployment status in DB and broadcast to clients. */
async function setStatus(deployment, status) {
  deployment.status = status;
  if (['success', 'failed', 'crashed', 'removed'].includes(status)) {
    deployment.completedAt = new Date();
  }
  await deployment.save();
  if (ioInstance) {
    ioInstance.to(`deployment:${deployment._id}`).emit('deployment:status', {
      deploymentId: deployment._id.toString(),
      status,
    });
  }
}

/** Broadcast a project-level status change to all dashboard subscribers. */
async function broadcastProjectStatus(project) {
  if (ioInstance) {
    ioInstance.to('dashboard').emit('project:status', {
      projectId: project._id.toString(),
      status:    project.status,
    });
  }
}

module.exports = { attachIO, broadcast, setStatus, broadcastProjectStatus };
