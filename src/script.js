var fs = require('fs')
  , path = require('path')

var hardwareResolve = require('hardware-resolve')
  , effess = require('effess')
  , humanize = require('humanize')
  , tessel = require('../')

// analyzeScript (string arg, { verbose, single }) -> { pushdir, relpath, files, size }
// Given a command-line file path, resolve whether we are bundling a file, 
// its directory, or its ancestral node module.

function analyzeScript (arg, opts)
{
  function duparg (arr) {
    var obj = {};
    arr.forEach(function (arg) {
      obj[arg] = arg;
    })
    return obj;
  }

  var ret = {};

  hardwareResolve.root(arg, function (err, pushdir, relpath) {
    var files;
    if (opts.single || !pushdir) {
      if (!opts.single && fs.lstatSync(arg).isDirectory()) {
        ret.warning = String(err || 'Warning.').replace(/\.( |$)/, ', pushing just this directory.');

        pushdir = fs.realpathSync(arg);
        relpath = fs.lstatSync(path.join(arg, 'index.js')) && 'index.js';
        files = duparg(effess.readdirRecursiveSync(arg, {
          inflateSymlinks: true,
          excludeHiddenUnix: true
        }))
      } else {
        ret.warning = String(err || 'Warning.').replace(/\.( |$)/, ', pushing just this file.');

        pushdir = path.dirname(fs.realpathSync(arg));
        relpath = path.basename(arg);
        files = duparg([path.basename(arg)]);
      }
    } else {
      // Parse defaults from command line for inclusion or exclusion
      var defaults = {};
      if (typeof opts.x == 'string') {
        opts.x = [opts.x];
      }
      if (opts.x) {
        opts.x.forEach(function (arg) {
          defaults[arg] = false;
        })
      }
      if (typeof opts.i == 'string') {
        opts.i = [opts.i];
      }
      if (opts.i) {
        opts.i.forEach(function (arg) {
          defaults[arg] = true;
        })
      }

      // Get list of hardware files.
      files = hardwareResolve.list(pushdir, null, null, defaults);
      // Ensure the requested file from command line is included, even if blacklisted
      if (!(relpath in files)) {
        files[relpath] = relpath;
      }
    }

    ret.pushdir = pushdir;
    ret.relpath = relpath;
    ret.files = files;

    // Update files values to be full paths in pushFiles.
    Object.keys(ret.files).forEach(function (file) {
      ret.files[file] = fs.realpathSync(path.join(pushdir, ret.files[file]));
    })
  })

  // Dump stats for files and their sizes.
  var sizelookup = {};
  Object.keys(ret.files).forEach(function (file) {
    sizelookup[file] = fs.lstatSync(ret.files[file]).size;
    var dir = file;
    do {
      dir = path.dirname(dir);
      sizelookup[dir + '/'] = (sizelookup[dir + '/'] || 0) + sizelookup[file];
    } while (path.dirname(dir) != dir);
  });
  if (opts.verbose) {
    Object.keys(sizelookup).sort().forEach(function (file) {
      console.error('LOG'.cyan.blueBG, file.match(/\/$/) ? ' ' + file.underline : ' \u2192 ' + file, '(' + humanize.filesize(sizelookup[file]) + ')');
    });
    console.error('LOG'.cyan.blueBG, 'Total file size:', humanize.filesize(sizelookup['./'] || 0));
  }
  ret.size = sizelookup['./'] || 0;

  return ret;
}

// client#run(pushpath, args, next(err))
// Run and deploy a script to this Tessel.
// Meant to be a simplification of the bundling process.

tessel.Tessel.prototype.run = function (pushpath, argv, bundleopts, next)
{
  var self = this;
  var verbose = bundleopts;
  if (typeof bundleopts == 'function') {
    next = bundleopts;
    bundleopts = {};
  }

  // Bundle code based on file path.
  var ret = analyzeScript(pushpath, bundleopts);
  if (ret.warning) {
    console.error(('WARN').yellow, ret.warning.grey);
  }
  verbose && console.error(('Bundling directory ' + ret.pushdir + ' (~' + humanize.filesize(ret.size) + ')').grey);

  // Create archive and deploy it to tessel.
  tessel.bundleFiles(ret.relpath, argv, ret.files, function (err, tarbundle) {
    if (bundleopts.save) {
      if (bundleopts.savePath) {
        // save the bundle to the path
        fs.writeFile(bundleopts.savePath, tarbundle, function(err){
          if (err) throw err;
        });
      } else {
        // save to any rando location 
        fs.writeFile('tarbundle.tar', tarbundle, function(err){
          if (err) throw err;
        });
      }
    }

    verbose && console.error(('Deploying bundle (' + humanize.filesize(tarbundle.length) + ')...').grey);
    self.deployBundle(tarbundle, bundleopts, next);
  })
}


// tessel.script(pushpath, args, next(err))
// Dead-simple mechanism for pushing code to Tessel.

function script (pushpath, args, next)
{
  tessel.findTessel(null, function (err, client) {
    // client.listen(true, [10, 11, 12, 13, 20, 21, 22])

    if (err) {
      throw new Error('No tessel connected, aborting: ' + err);
    }

    client.run(pushpath, args, function (err) {
      // Log errors.
      client.on('error', function (err) {
        console.error('Error: Cannot connect to Tessel locally.', err);
      })

      // Bundle and upload code.
      console.error('uploading tessel code...'.grey);

      // When this script ends, stop the client.
      client.once('script-stop', function (code) {
        // console.log('stopped.'.grey);
        client.close();
      });

      // Handle running script.
      next(err, client);
    })
  });
}

tessel.analyzeScript = analyzeScript;
tessel.script = script;