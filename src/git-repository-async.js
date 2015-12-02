'use babel'

import fs from 'fs-plus'
import Git from 'nodegit'
import path from 'path'
import {Emitter, CompositeDisposable, Disposable} from 'event-kit'

const modifiedStatusFlags = Git.Status.STATUS.WT_MODIFIED | Git.Status.STATUS.INDEX_MODIFIED | Git.Status.STATUS.WT_DELETED | Git.Status.STATUS.INDEX_DELETED | Git.Status.STATUS.WT_TYPECHANGE | Git.Status.STATUS.INDEX_TYPECHANGE
const newStatusFlags = Git.Status.STATUS.WT_NEW | Git.Status.STATUS.INDEX_NEW
const deletedStatusFlags = Git.Status.STATUS.WT_DELETED | Git.Status.STATUS.INDEX_DELETED
const indexStatusFlags = Git.Status.STATUS.INDEX_NEW | Git.Status.STATUS.INDEX_MODIFIED | Git.Status.STATUS.INDEX_DELETED | Git.Status.STATUS.INDEX_RENAMED | Git.Status.STATUS.INDEX_TYPECHANGE

// Just using this for _.isEqual and _.object, we should impl our own here
import _ from 'underscore-plus'

export default class GitRepositoryAsync {
  static open (path, options = {}) {
    // QUESTION: Should this wrap Git.Repository and reject with a nicer message?
    return new GitRepositoryAsync(path, options)
  }

  static get Git () {
    return Git
  }

  constructor (path, options) {
    this.repo = null
    this.emitter = new Emitter()
    this.subscriptions = new CompositeDisposable()
    this.pathStatusCache = {}
    this.repoPromise = Git.Repository.open(path)
    this.isCaseInsensitive = fs.isCaseInsensitive()
    this._refreshingCount = 0

    let {refreshOnWindowFocus} = options || true
    if (refreshOnWindowFocus) {
      const onWindowFocus = () => this.refreshStatus()
      window.addEventListener('focus', onWindowFocus)
      this.subscriptions.add(new Disposable(() => window.removeEventListener('focus', onWindowFocus)))
    }

    const {project} = options
    this.project = project
    if (this.project) {
      this.project.getBuffers().forEach(buffer => this.subscribeToBuffer(buffer))
      this.subscriptions.add(this.project.onDidAddBuffer(buffer => this.subscribeToBuffer(buffer)))
    }
  }

  destroy () {
    if (this.emitter) {
      this.emitter.emit('did-destroy')
      this.emitter.dispose()
      this.emitter = null
    }
    if (this.subscriptions) {
      this.subscriptions.dispose()
      this.subscriptions = null
    }
  }

  // Event subscription
  // ==================

  onDidDestroy (callback) {
    return this.emitter.on('did-destroy', callback)
  }

  onDidChangeStatus (callback) {
    return this.emitter.on('did-change-status', callback)
  }

  onDidChangeStatuses (callback) {
    return this.emitter.on('did-change-statuses', callback)
  }

  // Repository details
  // ==================

  // Public: A {String} indicating the type of version control system used by
  // this repository.
  //
  // Returns `"git"`.
  getType () {
    return 'git'
  }

  // Public: Returns a {Promise} which resolves to the {String} path of the
  // repository.
  getPath () {
    return this.repoPromise.then(repo => repo.path().replace(/\/$/, ''))
  }

  // Public: Returns a {Promise} which resolves to the {String} working
  // directory path of the repository.
  getWorkingDirectory () {
    throw new Error('Unimplemented')
  }

  // Public: Returns a {Promise} that resolves to true if at the root, false if
  // in a subfolder of the repository.
  isProjectAtRoot () {
    if (!this.projectAtRoot && this.project) {
      this.projectAtRoot = Promise.resolve(() => {
        return this.repoPromise.then(repo => this.project.relativize(repo.workdir))
      })
    }

    return this.projectAtRoot
  }

  // Public: Makes a path relative to the repository's working directory.
  relativize (_path, workingDirectory) {
    // Cargo-culted from git-utils. The original implementation also handles
    // this.openedWorkingDirectory, which is set by git-utils when the
    // repository is opened. Those branches of the if tree aren't included here
    // yet, but if we determine we still need that here it should be simple to
    // port.
    //
    // The original implementation also handled null workingDirectory as it
    // pulled it from a sync function that could return null. We require it
    // to be passed here.
    if (!_path || !workingDirectory) {
      return _path
    }

    if (process.platform === 'win32') {
      _path = _path.replace(/\\/g, '/')
    } else {
      if (_path[0] !== '/') {
        return _path
      }
    }

    if (!/\/$/.test(workingDirectory)) {
      workingDirectory = `${workingDirectory}/`
    }

    if (this.isCaseInsensitive) {
      const lowerCasePath = _path.toLowerCase()

      workingDirectory = workingDirectory.toLowerCase()
      if (lowerCasePath.indexOf(workingDirectory) === 0) {
        return _path.substring(workingDirectory.length)
      } else {
        if (lowerCasePath === workingDirectory) {
          return ''
        }
      }
    }

    return _path
  }

  // Public: Returns true if the given branch exists.
  hasBranch (branch) {
    throw new Error('Unimplemented')
  }

  // Public: Retrieves a shortened version of the HEAD reference value.
  //
  // This removes the leading segments of `refs/heads`, `refs/tags`, or
  // `refs/remotes`.  It also shortens the SHA-1 of a detached `HEAD` to 7
  // characters.
  //
  // * `path` An optional {String} path in the repository to get this information
  //   for, only needed if the repository contains submodules.
  //
  // Returns a {String}.
  getShortHead (path) {
    throw new Error('Unimplemented')
  }

  // Public: Is the given path a submodule in the repository?
  //
  // * `path` The {String} path to check.
  //
  // Returns a {Promise} that resolves true if the given path is a submodule in
  // the repository.
  isSubmodule (_path) {
    return this.repoPromise
      .then(repo => repo.openIndex())
      .then(index => {
        const entry = index.getByPath(_path)
        const submoduleMode = 57344 // TODO compose this from libgit2 constants
        return entry.mode === submoduleMode
      })
  }

  // Public: Returns the number of commits behind the current branch is from the
  // its upstream remote branch.
  //
  // * `reference` The {String} branch reference name.
  // * `path`      The {String} path in the repository to get this information for,
  //   only needed if the repository contains submodules.
  getAheadBehindCount (reference, path) {
    throw new Error('Unimplemented')
  }

  // Public: Get the cached ahead/behind commit counts for the current branch's
  // upstream branch.
  //
  // * `path` An optional {String} path in the repository to get this information
  //   for, only needed if the repository has submodules.
  //
  // Returns an {Object} with the following keys:
  //   * `ahead`  The {Number} of commits ahead.
  //   * `behind` The {Number} of commits behind.
  getCachedUpstreamAheadBehindCount (path) {
    throw new Error('Unimplemented')
  }

  // Public: Returns the git configuration value specified by the key.
  //
  // * `path` An optional {String} path in the repository to get this information
  //   for, only needed if the repository has submodules.
  getConfigValue (key, path) {
    throw new Error('Unimplemented')
  }

  // Public: Returns the origin url of the repository.
  //
  // * `path` (optional) {String} path in the repository to get this information
  //   for, only needed if the repository has submodules.
  getOriginURL (path) {
    throw new Error('Unimplemented')
  }

  // Public: Returns the upstream branch for the current HEAD, or null if there
  // is no upstream branch for the current HEAD.
  //
  // * `path` An optional {String} path in the repo to get this information for,
  //   only needed if the repository contains submodules.
  //
  // Returns a {String} branch name such as `refs/remotes/origin/master`.
  getUpstreamBranch (path) {
    throw new Error('Unimplemented')
  }

  // Public: Gets all the local and remote references.
  //
  // * `path` An optional {String} path in the repository to get this information
  //   for, only needed if the repository has submodules.
  //
  // Returns an {Object} with the following keys:
  //  * `heads`   An {Array} of head reference names.
  //  * `remotes` An {Array} of remote reference names.
  //  * `tags`    An {Array} of tag reference names.
  getReferences (path) {
    throw new Error('Unimplemented')
  }

  // Public: Returns the current {String} SHA for the given reference.
  //
  // * `reference` The {String} reference to get the target of.
  // * `path` An optional {String} path in the repo to get the reference target
  //   for. Only needed if the repository contains submodules.
  getReferenceTarget (reference, path) {
    throw new Error('Unimplemented')
  }

  // Reading Status
  // ==============

  isPathModified (_path) {
    return this._filterStatusesByPath(_path).then(statuses => {
      return statuses.filter(status => status.isModified()).length > 0
    })
  }

  isPathNew (_path) {
    return this._filterStatusesByPath(_path).then(statuses => {
      return statuses.filter(status => status.isNew()).length > 0
    })
  }

  isPathIgnored (_path) {
    return this.repoPromise.then(repo => Git.Ignore.pathIsIgnored(repo, _path))
  }

  // Get the status of a directory in the repository's working directory.
  //
  // * `directoryPath` The {String} path to check.
  //
  // Returns a promise resolving to a {Number} representing the status. This value can be passed to
  // {::isStatusModified} or {::isStatusNew} to get more information.

  getDirectoryStatus (directoryPath) {
    let relativePath
    // XXX _filterSBD already gets repoPromise
    return this.repoPromise
      .then(repo => {
        relativePath = this.relativize(directoryPath, repo.workdir())
        return this._filterStatusesByDirectory(relativePath)
      })
      .then(statuses => {
        return Promise.all(statuses.map(s => s.statusBit())).then(bits => {
          let directoryStatus = 0
          const filteredBits = bits.filter(b => b > 0)
          if (filteredBits.length > 0) {
            filteredBits.forEach(bit => directoryStatus |= bit)
          }

          return directoryStatus
        })
      })
  }

  // Refresh the status bit for the given path.
  //
  // Note that if the status of the path has changed, this will emit a
  // 'did-change-status' event.
  //
  // path    :: String
  //            The path whose status should be refreshed.
  //
  // Returns :: Promise<Number>
  //            The refreshed status bit for the path.
  refreshStatusForPath (_path) {
    this._refreshingCount++

    let relativePath
    return this.repoPromise
      .then(repo => {
        relativePath = this.relativize(_path, repo.workdir())
        return this._filterStatusesByPath(_path)
      })
      .then(statuses => {
        const cachedStatus = this.pathStatusCache[relativePath] || 0
        const status = statuses[0] ? statuses[0].statusBit() : Git.Status.STATUS.CURRENT
        if (status !== cachedStatus) {
          this.pathStatusCache[relativePath] = status
          this.emitter.emit('did-change-status', {path: _path, pathStatus: status})
        }

        return status
      })
      .then(_ => this._refreshingCount--)
  }

  // Returns a Promise that resolves to the status bit of a given path if it has
  // one, otherwise 'current'.
  getPathStatus (_path) {
    return this.refreshStatusForPath(_path)
  }

  // Public: Get the cached status for the given path.
  //
  // * `path` A {String} path in the repository, relative or absolute.
  //
  // Returns a {Promise} which resolves to a status {Number} or null if the
  // path is not in the cache.
  getCachedPathStatus (_path) {
    return this.repoPromise
      .then(repo => this.relativize(_path, repo.workdir()))
      .then(relativePath => this.pathStatusCache[relativePath])
  }

  isStatusNew (statusBit) {
    return (statusBit & newStatusFlags) > 0
  }

  isStatusModified (statusBit) {
    return (statusBit & modifiedStatusFlags) > 0
  }

  isStatusStaged (statusBit) {
    return (statusBit & indexStatusFlags) > 0
  }

  isStatusIgnored (statusBit) {
    return (statusBit & (1 << 14)) > 0
  }

  isStatusDeleted (statusBit) {
    return (statusBit & deletedStatusFlags) > 0
  }

  // Checking Out
  // ============

  // Public: Restore the contents of a path in the working directory and index
  // to the version at `HEAD`.
  //
  // This is essentially the same as running:
  //
  // ```sh
  //   git reset HEAD -- <path>
  //   git checkout HEAD -- <path>
  // ```
  //
  // * `path` The {String} path to checkout.
  //
  // Returns a {Promise} that resolves or rejects depending on whether the
  // method was successful.
  checkoutHead (_path) {
    return this.repoPromise
      .then(repo => {
        const checkoutOptions = new Git.CheckoutOptions()
        checkoutOptions.paths = [this.relativize(_path, repo.workdir())]
        checkoutOptions.checkoutStrategy = Git.Checkout.STRATEGY.FORCE | Git.Checkout.STRATEGY.DISABLE_PATHSPEC_MATCH
        return Git.Checkout.head(repo, checkoutOptions)
      })
      .then(() => this.refreshStatusForPath(_path))
  }

  checkoutHeadForEditor (editor) {
    return new Promise((resolve, reject) => {
      const filePath = editor.getPath()
      if (filePath) {
        if (editor.buffer.isModified()) {
          editor.buffer.reload()
        }
        resolve(filePath)
      } else {
        reject()
      }
    }).then(filePath => this.checkoutHead(filePath))
  }

  // Private
  // =======

  // Get the current branch and update this.branch.
  //
  // Returns :: Promise<String>
  //            The branch name.
  _refreshBranch () {
    return this.repoPromise
      .then(repo => repo.getCurrentBranch())
      .then(ref => ref.name())
      .then(branchRef => this.branch = branchRef)
  }

  // Refreshes the git status.
  //
  // Returns :: Promise<???>
  //            Resolves when refresh has completed.
  refreshStatus () {
    this._refreshingCount++

    // TODO add upstream, branch, and submodule tracking
    const status = this.repoPromise
      .then(repo => repo.getStatus())
      .then(statuses => {
        // update the status cache
        const statusPairs = statuses.map(status => [status.path(), status.statusBit()])
        return Promise.all(statusPairs)
          .then(statusesByPath => _.object(statusesByPath))
      })
      .then(newPathStatusCache => {
        if (!_.isEqual(this.pathStatusCache, newPathStatusCache) && this.emitter != null) {
          this.emitter.emit('did-change-statuses')
        }
        this.pathStatusCache = newPathStatusCache
        return newPathStatusCache
      })

    const branch = this._refreshBranch()

    return Promise.all([status, branch]).then(_ => this._refreshingCount--)
  }

  // Section: Private
  // ================

  _isRefreshing () {
    return this._refreshingCount === 0
  }

  subscribeToBuffer (buffer) {
    const bufferSubscriptions = new CompositeDisposable()

    const refreshStatusForBuffer = () => {
      const _path = buffer.getPath()
      if (_path) {
        this.refreshStatusForPath(_path)
      }
    }

    bufferSubscriptions.add(
      buffer.onDidSave(refreshStatusForBuffer),
      buffer.onDidReload(refreshStatusForBuffer),
      buffer.onDidChangePath(refreshStatusForBuffer),
      buffer.onDidDestroy(() => {
        bufferSubscriptions.dispose()
        this.subscriptions.remove(bufferSubscriptions)
      })
    )

    this.subscriptions.add(bufferSubscriptions)
    return
  }

  _filterStatusesByPath (_path) {
    // Surely I'm missing a built-in way to do this
    let basePath = null
    return this.repoPromise
      .then(repo => {
        basePath = repo.workdir()
        return repo.getStatus()
      })
      .then(statuses => {
        return statuses.filter(status => _path === path.join(basePath, status.path()))
      })
  }

  _filterStatusesByDirectory (directoryPath) {
    return this.repoPromise
      .then(repo => repo.getStatus())
      .then(statuses => {
        return statuses.filter(status => status.path().indexOf(directoryPath) === 0)
      })
  }
}
