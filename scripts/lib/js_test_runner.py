# Copyright (c) 2015-present, Facebook, Inc.
# All rights reserved.
#
# This source code is licensed under the license found in the LICENSE file in
# the root directory of this source tree.

import logging
import os
import platform_checker
import subprocess

from multiprocessing import Pool, cpu_count


class JsTestRunner(object):
    def __init__(self, package_manager, include_apm=True):
        self._package_manager = package_manager
        self._include_apm = include_apm

    def run_tests(self):
        apm_tests = []
        npm_tests = []
        for package_config in self._package_manager.get_configs():
            if package_config['excludeTestsFromContinuousIntegration']:
                continue

            test_runner = package_config['testRunner']
            if test_runner == 'apm' and not self._include_apm:
                continue

            pkg_path = package_config['packageRootAbsolutePath']
            name = package_config['name']
            test_args = (test_runner, pkg_path, name)
            test_bucket = npm_tests if test_runner == 'npm' else apm_tests
            test_bucket.append(test_args)

        if platform_checker.is_windows():
            # We run all tests in serial on Windows because Python's multiprocessing library has issues:
            # https://docs.python.org/2/library/multiprocessing.html#windows
            parallel_tests = []
            serial_tests = npm_tests + apm_tests
        else:
            # For now, we run the npm tests in parallel, but the apm tests serially.
            # Once we are certain that apm tests can be run in parallel in a stable way,
            # we will run all tests in parallel.
            parallel_tests = npm_tests
            serial_tests = apm_tests

        if parallel_tests:
            pool = Pool(processes=cpu_count())
            results = [pool.apply_async(run_js_test, args=test_args) for test_args in parallel_tests]
            for async_result in results:
                async_result.wait()
                if not async_result.successful():
                    raise async_result.get()

        for test_args in serial_tests:
            (test_runner, pkg_path, name) = test_args
            run_js_test(test_runner, pkg_path, name)


def run_js_test(test_runner, pkg_path, name):
    logging.info('Running `%s test` in %s...', test_runner, pkg_path)

    # Add --one option to `apm test` to ensure no deprecated APIs are used:
    # http://blog.atom.io/2015/05/01/removing-deprecated-apis.html.
    test_args = [test_runner, 'test']
    if test_runner == 'apm':
        test_args += ['--one']

    shell = True if platform_checker.is_windows() else False
    proc = subprocess.Popen(
            test_args,
            cwd=pkg_path,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            shell=shell)
    stdout = []
    for line in proc.stdout:
        logging.info('[%s test %s]: %s', test_runner, name, line.rstrip())
        stdout.append(line)
    proc.wait()

    if proc.returncode:
        logging.info('TEST FAILED: %s\nstdout:\n%s', name, '\n'.join(stdout))
        raise Exception('TEST FAILED: %s test %s' % (test_runner, name))
    else:
        logging.info('TEST PASSED: %s', name)
        logging.info('Done testing %s', name)
