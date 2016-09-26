'use strict';

const RSVP = require('rsvp');
const CoreObject = require('core-object');
const debug = require('debug')('ember-cli-fastboot/server');
const exec = RSVP.denodeify(require('child_process').exec);
const http = require('http');
const path = require('path');
const express = require('express');
const fastbootMiddleware = require('fastboot-express-middleware');
const FastBoot = require('fastboot');

module.exports = CoreObject.extend({

  exec,
  http,
  httpServer: null,
  fastboot: null,
  nextSocketId: 0,
  require,
  restartAgain: false,
  restartPromise: null,
  sockets: {},

  run(options) {
    debug('run');
    const ready = () => this.outputReady(options);
    this.addon.on('outputReady', ready);
  },

  start(options) {
    debug('start');

    this.fastboot = new FastBoot({
      distPath: options.outputPath
    });

    const middleware = fastbootMiddleware({
      outputPath: options.outputPath,
      fastboot: this.fastboot
    });

    const app = express();
    app.use(require('compression')());

    if (options.serveAssets) {
      app.get('/', middleware);
      app.use(express.static(options.assetsPath));
    }
    app.get('/*', middleware);
    app.use((req, res) => res.sendStatus(404));

    this.httpServer = this.http.createServer(app);

    // Track open sockets for fast restart
    this.httpServer.on('connection', (socket) => {
      const socketId = this.nextSocketId++;
      debug(`open socket ${socketId}`);
      this.sockets[socketId] = socket;
      socket.on('close', () => {
        debug(`close socket ${socketId}`);
        delete this.sockets[socketId];
      });
    });

    return new RSVP.Promise((resolve, reject) => {
      this.httpServer.listen(options.port, options.host, (err) => {
        if (err) { return reject(err); }
        const o = this.httpServer.address();
        const port = o.port;
        const family = o.family;
        let host = o.address;
        if (family === 'IPv6') { host = `[${host}]`; }
        this.ui.writeLine(`Ember FastBoot running at http://${host}:${port}`);
        resolve();
      });
    });
  },

  stop() {
    debug('stop');
    return new RSVP.Promise((resolve, reject) => {
      if (!this.httpServer) { return resolve(); }

      // Stop accepting new connections
      this.httpServer.close((err) => {
        debug('close', Object.keys(this.sockets));
        if (err) { return reject(err); }
        this.httpServer = null;
        resolve();
      });

      // Force close existing connections
      Object.keys(this.sockets).forEach(k => this.sockets[k].destroy());
    });
  },

  outputReady(options) {
    if (this.fastboot) {
      this.ui.writeLine(`Reloading FastBoot`);
      return this.fastboot.reload();
    } else {
      return this.start(options)
        .catch(e => this.printError(e));
    }
  },

  /*
   * Try to show a useful error message if we're not able to start the user's
   * app in FastBoot.
   */
  printError: function(e) {
    var preamble = ["There was an error trying to run your application in FastBoot.\n",
      "This is usually caused by either your application code or an addon trying to access " +
      "an API that isn't available in Node.js."];

    // If there's a stack trace available, try to extract some information for
    // it so we can generate a more helpful error message.
    if (e.stack) {
      // Look at the stack trace line by line
      var stack = e.stack.split('\n');

      // Verify there's a second line with path information.
      // (First line is the error message itself.)
      if (stack[1]) {
        // Extract path and line number information. An example line looks like either:
        //     at /Users/monegraph/Code/fastboot-test/dist/fastboot/vendor.js:65045:19
        // or
        //     at Module.callback (/Users/monegraph/Code/fastboot test/dist/fastboot/fastboot-test.js:23:31)
        var match = stack[1].match(/\s*(?:at .* \(([^:]+):(\d+):(\d+)|at ([^:]+):(\d+):(\d+)$)/);
        if (match) {
          var fileName = match[1] || match[4];
          var lineNumber = match[2] || match[5];

          // Print file name and line number from the top of the stack. This is displayed
          // anyway, of course, but not everyone knows how to read a stack trace. This makes
          // it more obvious.
          var badFilePath = path.relative(process.cwd(), fileName);
          preamble.push("Based on the stack trace, it looks like the exception was generated in " + badFilePath + " on line " + lineNumber + ".");

          // If the exception is coming from `vendor.js`, that usually means it's from an addon and thus may be
          // out of the user's control. Give the user some instructions so they can try to figure out which
          // addon is causing the problem.
          if (fileName.substr(-9) === 'vendor.js') {
            preamble.push("Because it's coming from vendor.js, an addon is most likely responsible for this error. You should look at this " +
                          "file and line number to determine which addon is not yet FastBoot compatible.");

          } else {
            preamble.push("The exception is probably coming from your app. Look at this file and line number to determine what is triggering the exception.");
          }
        }
      }

      preamble.push("\nThe full stack trace is:");
    }

    this.ui.writeError(preamble.join('\n') + '\n');
    this.ui.writeError(e);
  }
});
