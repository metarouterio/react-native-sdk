require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name         = "metarouter-react-native-sdk"
  s.version      = package['version']
  s.summary      = "MetaRouter React Native SDK native modules"
  s.homepage     = package['repository']['url']
  s.license      = package['license']
  s.author       = package['author']
  s.source       = { :git => package['repository']['url'], :tag => s.version }

  s.platform     = :ios, '13.0'

  s.source_files = "ios/**/*.{h,m,mm,swift}"

  s.dependency "React-Core"
end
